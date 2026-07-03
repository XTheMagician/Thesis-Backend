import type {
  ActiveRules,
  Condition,
  Decision,
  QueuedTicket,
  SessionStats,
  SortResult,
  Ticket,
} from './types';

const DEFAULT_RULES: ActiveRules = {
  software: 'ai',
  shipping: 'ai',
  general: 'ai',
  accounting: 'human',
  hr: 'human',
  returns: 'human',
};

export interface SessionConstructorParams {
  participantId: string;
  condition: Condition;
  ticketIntervalMs: number;
  ticketJitter?: number;
  sessionTimerMs?: number;
}

export class Session {
  readonly id: string;
  readonly participantId: string;
  readonly condition: Condition;
  readonly ticketIntervalMs: number;
  readonly ticketJitter: number;
  readonly sessionTimerMs: number | null;

  status: 'running' | 'paused' | 'ended';
  readonly startedAt: number;
  endedAt: number | null = null;
  duration: number | null = null;

  // Pause tracking
  pausedAt: number | null = null;
  totalPausedMs: number = 0;

  activeRules: ActiveRules;
  queue: QueuedTicket[] = [];
  results: SortResult[] = [];
  stats: SessionStats = { total: 0, correct: 0, wrong: 0 };

  // Timer handles for cleanup — managed externally by the router
  _dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  _ruleTimers: ReturnType<typeof setTimeout>[] = [];
  _sessionTimer: ReturnType<typeof setTimeout> | null = null;

  // Remaining times stored on pause (so router can recreate timers)
  _sessionTimerRemainingMs: number | null = null;
  _dispatchRemainingMs: number | null = null;
  _lastDispatchAt: number = 0;

  // Dispatch state (so dispatch can be resumed after pause)
  _ticketPool: Ticket[] = [];
  _ticketIndex: number = 0;

  // Rule schedule (so unfired rules can be rescheduled after pause)
  _ruleSchedule: import('./types').RuleScheduleEntry[] = [];

  constructor({ participantId, condition, ticketIntervalMs, ticketJitter, sessionTimerMs }: SessionConstructorParams) {
    this.id = `${participantId}-${condition}-${Date.now()}`;
    this.participantId = participantId;
    this.condition = condition;
    this.ticketIntervalMs = ticketIntervalMs;
    this.ticketJitter = ticketJitter ?? 0;
    this.sessionTimerMs = sessionTimerMs ?? null;
    this.status = 'running';
    this.startedAt = Date.now();
    this._lastDispatchAt = this.startedAt;
    this.activeRules = { ...DEFAULT_RULES };
  }

  /** Returns a randomized interval: base ± (base * jitter). Minimum 500ms. */
  randomizedInterval(): number {
    if (this.ticketJitter <= 0) return this.ticketIntervalMs;
    const offset = (Math.random() * 2 - 1) * this.ticketJitter * this.ticketIntervalMs;
    return Math.max(500, Math.round(this.ticketIntervalMs + offset));
  }

  enqueue(ticket: Ticket): void {
    this.queue.push({ ...ticket, queuedAt: Date.now() });
  }

  sort(ticketId: string, decision: Decision): { ticket: QueuedTicket; result: SortResult } | null {
    const idx = this.queue.findIndex((t) => t.id === ticketId);
    if (idx === -1) return null;

    const [ticket] = this.queue.splice(idx, 1);
    const correct = this.activeRules[ticket.category] === decision;
    const sortedAt = Date.now();

    const result: SortResult = {
      ticketId: ticket.id,
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

  applyRules(patch: Partial<ActiveRules>): ActiveRules {
    this.activeRules = { ...this.activeRules, ...patch };
    return this.activeRules;
  }

  pause(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pausedAt = Date.now();

    // Store remaining time for session timer
    if (this._sessionTimer && this.sessionTimerMs != null) {
      const elapsed = Date.now() - this.startedAt - this.totalPausedMs;
      this._sessionTimerRemainingMs = Math.max(0, this.sessionTimerMs - elapsed);
      clearTimeout(this._sessionTimer);
      this._sessionTimer = null;
    }

    // Store remaining time until next dispatch tick
    if (this._dispatchTimer) {
      this._dispatchRemainingMs = Math.max(0, this.ticketIntervalMs - (Date.now() - this._lastDispatchAt));
      clearTimeout(this._dispatchTimer);
      this._dispatchTimer = null;
    }

    // Clear rule timers (remaining times calculated by router)
    this._ruleTimers.forEach(clearTimeout);
    this._ruleTimers = [];
  }

  resume(): void {
    if (this.status !== 'paused' || this.pausedAt == null) return;
    this.totalPausedMs += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.status = 'running';
  }

  /** Elapsed active time (excludes paused time) */
  get elapsedActiveMs(): number {
    const now = this.status === 'paused' && this.pausedAt ? this.pausedAt : Date.now();
    return now - this.startedAt - this.totalPausedMs;
  }

  end(): void {
    this.status = 'ended';
    this.endedAt = Date.now();
    this.duration = this.endedAt - this.startedAt - this.totalPausedMs;

    if (this._dispatchTimer) clearTimeout(this._dispatchTimer);
    if (this._sessionTimer) clearTimeout(this._sessionTimer);
    this._ruleTimers.forEach(clearTimeout);
  }
}
