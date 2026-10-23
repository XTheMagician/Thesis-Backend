import type {
  ActiveRules,
  Decision,
  QueuedTicket,
  RobotCondition,
  RobotConfig,
  RuleScheduleEntry,
  SessionStats,
  SortResult,
  TaskCondition,
  Ticket,
} from '../types';
import { shuffle } from './tickets';
import { initialRules, type CategoryCount } from './categories';

/**
 * Domain events the task engine raises. The orchestrator subscribes and
 * handles logging/broadcasting — the session itself never talks to sockets.
 */
export type SessionEvent =
  | { kind: 'ticketQueued'; ticket: QueuedTicket; queueLength: number }
  | { kind: 'rulesChanged'; rules: ActiveRules; robotSpeech: string | null }
  | { kind: 'timerExpired' };

export interface SessionParams {
  participantId: string;
  taskCondition: TaskCondition;
  robotCondition: RobotCondition;
  robotConfig: RobotConfig;
  ticketIntervalMs: number;
  ticketJitter?: number;
  categoryCount: CategoryCount;
  sessionTimerMs?: number;
  ticketPool: Ticket[];
  ruleSchedule?: RuleScheduleEntry[];
  demo?: boolean;
  onEvent: (event: SessionEvent) => void;
}

export class Session {
  readonly id: string;
  readonly participantId: string;
  readonly taskCondition: TaskCondition;
  readonly robotCondition: RobotCondition;
  readonly robotConfig: RobotConfig;
  readonly ticketIntervalMs: number;
  readonly ticketJitter: number;
  /** Categories per side; only these appear in activeRules and the ticket pool */
  readonly categoryCount: CategoryCount;
  readonly sessionTimerMs: number | null;
  /** Demo run: no briefing, no voice, nothing logged */
  readonly demo: boolean;

  /** 'briefing' until begin(): the robot explains the task, nothing is dispatched yet */
  status: 'briefing' | 'running' | 'paused' | 'ended';
  readonly createdAt: number;
  /** When the task itself started (begin()); all task timing counts from here */
  startedAt: number;
  endedAt: number | null = null;
  duration: number | null = null;

  // Pause tracking
  pausedAt: number | null = null;
  totalPausedMs: number = 0;

  activeRules: ActiveRules;
  queue: QueuedTicket[] = [];
  results: SortResult[] = [];
  stats: SessionStats = { total: 0, correct: 0, wrong: 0 };

  private readonly onEvent: (event: SessionEvent) => void;
  private ticketPool: Ticket[];
  private readonly ruleSchedule: RuleScheduleEntry[];
  private ticketIndex = 0;
  /** 1-based pass through the pool; the pool is reshuffled and repeated once exhausted */
  private ticketRound = 1;

  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private ruleTimers: ReturnType<typeof setTimeout>[] = [];
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;

  // Remaining times captured on pause so timers can be recreated on resume
  private dispatchRemainingMs: number | null = null;
  private sessionTimerRemainingMs: number | null = null;
  private lastDispatchAt: number;

  constructor(params: SessionParams) {
    this.participantId = params.participantId;
    this.taskCondition = params.taskCondition;
    this.robotCondition = params.robotCondition;
    this.robotConfig = params.robotConfig;
    this.ticketIntervalMs = params.ticketIntervalMs;
    this.ticketJitter = params.ticketJitter ?? 0;
    this.categoryCount = params.categoryCount;
    this.sessionTimerMs = params.sessionTimerMs ?? null;
    this.ticketPool = params.ticketPool;
    this.ruleSchedule = params.ruleSchedule ?? [];
    this.demo = params.demo ?? false;
    this.onEvent = params.onEvent;

    const tag = this.demo ? '-demo' : '';
    this.id = `${params.participantId}-${params.taskCondition}-${params.robotCondition}${tag}-${Date.now()}`;
    this.status = 'briefing';
    this.createdAt = Date.now();
    this.startedAt = this.createdAt;
    this.lastDispatchAt = this.startedAt;
    this.activeRules = initialRules(this.categoryCount);
  }

  /** End the briefing: start dispatching tickets and arm the rule/session timers. */
  begin(): void {
    if (this.status !== 'briefing') return;
    this.status = 'running';
    this.startedAt = Date.now();
    this.lastDispatchAt = this.startedAt;
    this.scheduleNextTicket();
    this.scheduleRuleTimers();
    this.scheduleSessionTimer(this.sessionTimerMs ?? undefined);
  }

  pause(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pausedAt = Date.now();

    if (this.sessionTimer && this.sessionTimerMs != null) {
      const elapsed = Date.now() - this.startedAt - this.totalPausedMs;
      this.sessionTimerRemainingMs = Math.max(0, this.sessionTimerMs - elapsed);
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }

    if (this.dispatchTimer) {
      this.dispatchRemainingMs = Math.max(0, this.ticketIntervalMs - (Date.now() - this.lastDispatchAt));
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }

    // Rule timers are recomputed from elapsed active time on resume
    this.ruleTimers.forEach(clearTimeout);
    this.ruleTimers = [];
  }

  /** Returns the remaining session-timer ms so callers can report it. */
  resume(): number | null {
    if (this.status !== 'paused' || this.pausedAt == null) return null;
    this.totalPausedMs += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.status = 'running';

    this.scheduleNextTicket(this.dispatchRemainingMs ?? undefined);
    this.dispatchRemainingMs = null;

    this.scheduleRuleTimers();

    const remaining = this.sessionTimerRemainingMs;
    if (remaining != null) {
      this.scheduleSessionTimer(remaining);
      this.sessionTimerRemainingMs = null;
    }
    return remaining;
  }

  end(): void {
    const neverStarted = this.status === 'briefing';
    this.status = 'ended';
    this.endedAt = Date.now();
    this.duration = neverStarted ? 0 : this.endedAt - this.startedAt - this.totalPausedMs;

    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.ruleTimers.forEach(clearTimeout);
  }

  sort(ticketId: string, decision: Decision): { ticket: QueuedTicket; result: SortResult } | null {
    const idx = this.queue.findIndex((t) => t.id === ticketId);
    if (idx === -1) return null;

    const [ticket] = this.queue.splice(idx, 1);
    const correct = this.activeRules[ticket.category] === decision;
    const sortedAt = Date.now();

    const result: SortResult = {
      ticketId: ticket.id,
      ticketSourceId: ticket.sourceId,
      ticketCategory: ticket.category,
      decision,
      correct,
      activeRules: { ...this.activeRules },
      sortedAt,
      timeInQueueMs: sortedAt - ticket.queuedAt,
    };

    this.results.push(result);
    this.stats.total++;
    if (correct) this.stats.correct++;
    else this.stats.wrong++;

    return { ticket, result };
  }

  /** Elapsed active time (excludes paused time) */
  get elapsedActiveMs(): number {
    if (this.status === 'briefing') return 0;
    const now = this.status === 'paused' && this.pausedAt ? this.pausedAt : Date.now();
    return now - this.startedAt - this.totalPausedMs;
  }

  // ------------------------------------------------------------------ //
  //  Internal timers                                                     //
  // ------------------------------------------------------------------ //

  /** Randomized interval: base ± (base * jitter). Minimum 500ms. */
  private randomizedInterval(): number {
    if (this.ticketJitter <= 0) return this.ticketIntervalMs;
    const offset = (Math.random() * 2 - 1) * this.ticketJitter * this.ticketIntervalMs;
    return Math.max(500, Math.round(this.ticketIntervalMs + offset));
  }

  private scheduleNextTicket(delayMs?: number): void {
    const delay = delayMs ?? this.randomizedInterval();

    this.dispatchTimer = setTimeout(() => {
      if (this.status !== 'running') return;

      if (this.ticketIndex >= this.ticketPool.length) this.startNextRound();

      const source = this.ticketPool[this.ticketIndex++];
      const ticket: QueuedTicket = {
        ...source,
        // Repeated tickets need a unique id so sort() can't hit an earlier copy still in the queue
        id: this.ticketRound === 1 ? source.id : `${source.id}#${this.ticketRound}`,
        sourceId: source.id,
        queuedAt: Date.now(),
      };
      this.lastDispatchAt = Date.now();
      this.queue.push(ticket);
      this.onEvent({ kind: 'ticketQueued', ticket, queueLength: this.queue.length });

      // Chain the next dispatch
      this.scheduleNextTicket();
    }, delay);
  }

  /** Reshuffle the exhausted pool, avoiding the same ticket twice in a row across the boundary. */
  private startNextRound(): void {
    const last = this.ticketPool[this.ticketPool.length - 1];
    let next = shuffle(this.ticketPool);
    if (next.length > 1 && next[0].id === last.id) {
      next = [...next.slice(1), next[0]];
    }
    this.ticketPool = next;
    this.ticketIndex = 0;
    this.ticketRound++;
    console.log(`[Session] Ticket pool exhausted — starting round ${this.ticketRound}.`);
  }

  private scheduleRuleTimers(): void {
    if (this.taskCondition !== 'hard' || this.ruleSchedule.length === 0) return;

    const elapsed = this.elapsedActiveMs;

    for (const entry of this.ruleSchedule) {
      const remainingMs = entry.atSecond * 1000 - elapsed;
      if (remainingMs <= 0) continue; // already fired

      const timer = setTimeout(() => {
        if (this.status !== 'running') return;
        // Only reassign active categories; the admin may have set inactive ones in the schedule
        const changes = Object.entries(entry.rules).filter(([cat]) => cat in this.activeRules);
        this.activeRules = { ...this.activeRules, ...Object.fromEntries(changes) };
        this.onEvent({
          kind: 'rulesChanged',
          rules: this.activeRules,
          robotSpeech: entry.robotSpeech ?? null,
        });
      }, remainingMs);
      this.ruleTimers.push(timer);
    }
  }

  private scheduleSessionTimer(ms?: number): void {
    if (ms == null || ms <= 0) return;

    this.sessionTimer = setTimeout(() => {
      if (this.status !== 'running') return;
      this.onEvent({ kind: 'timerExpired' });
    }, ms);
  }
}
