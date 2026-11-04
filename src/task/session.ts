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
import {
  CHAT_SCHEDULE_SEC,
  CHAT_FALLBACK_GRACE_MS,
  DEFAULT_CHAT_TIMEOUT_MS,
} from '../config/liveChat';

/** Why a chat ended up a miss. */
export type ChatMissReason = 'clientTimeout' | 'noClientResponse';

/**
 * Domain events the task engine raises. The orchestrator subscribes and
 * handles logging/broadcasting — the session itself never talks to sockets.
 */
export type SessionEvent =
  | { kind: 'ticketQueued'; ticket: QueuedTicket; queueLength: number }
  | { kind: 'rulesChanged'; rules: ActiveRules; robotSpeech: string | null }
  | { kind: 'chatShow'; chatId: string; scheduledOnsetSec: number }
  | { kind: 'chatAccepted'; chatId: string; reactionTimeMs: number }
  | { kind: 'chatMissed'; chatId: string; reason: ChatMissReason; lostCustomers: number }
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
  /** Rule plan used in the hard condition ("Plan A", "Plan B", a saved preset name or "custom"). */
  rulePresetId?: string;
  /** Live-chat side task (resolved: default on in hard, forced off in easy). */
  chatEnabled?: boolean;
  chatTimeoutMs?: number;
  demo?: boolean;
  onEvent: (event: SessionEvent) => void;
}

/** Short, filename-safe tag for the hard-condition rule plan: "Plan A" → "A", "Plan B" → "B", otherwise a slug. */
function rulePlanTag(rulePresetId: string | undefined): string {
  const name = (rulePresetId ?? 'custom').trim();
  const builtin = /^plan\s+([a-z])$/i.exec(name);
  if (builtin) return builtin[1].toUpperCase();
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';
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

  // Live-chat side task (hard condition only). The frontend owns the reaction
  // clock and the visible timeout; the backend sends onsets, logs, and keeps a
  // fallback timer. Counts are session-cumulative; lostCustomers (= chatsMissed)
  // is the "Verlorene Kunden" measure.
  readonly chatEnabled: boolean;
  readonly chatTimeoutMs: number;
  /** The open chat awaiting a client report (accept/miss), or null. */
  activeChat: { chatId: string } | null = null;
  chatsShown = 0;
  chatsAccepted = 0;
  chatsMissed = 0;
  falseClicks = 0;
  /** Reaction times (ms) of accepted chats, for the mean in session:ended. */
  readonly reactionTimesMs: number[] = [];

  private readonly onEvent: (event: SessionEvent) => void;
  private ticketPool: Ticket[];
  private readonly ruleSchedule: RuleScheduleEntry[];
  /** Fixed chat onset times (seconds after task start); empty when disabled. */
  readonly chatSchedule: readonly number[];
  private ticketIndex = 0;
  /** 1-based pass through the pool; the pool is reshuffled and repeated once exhausted */
  private ticketRound = 1;

  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private ruleTimers: ReturnType<typeof setTimeout>[] = [];
  private chatTimers: ReturnType<typeof setTimeout>[] = [];
  private chatFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fallback deadline (epoch ms) for the open chat; restored across pause. */
  private chatFallbackDeadline: number | null = null;
  private chatFallbackRemainingMs: number | null = null;
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
    // Live chat only exists in the hard condition; easy forces it off.
    this.chatEnabled = params.taskCondition === 'hard' && params.chatEnabled !== false;
    this.chatTimeoutMs = params.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.chatSchedule = this.chatEnabled ? CHAT_SCHEDULE_SEC : [];
    this.demo = params.demo ?? false;
    this.onEvent = params.onEvent;

    const tag = this.demo ? '-demo' : '';
    const plan = params.taskCondition === 'hard' ? `-${rulePlanTag(params.rulePresetId)}` : '';
    this.id = `${params.participantId}-${params.taskCondition}${plan}-${params.robotCondition}${tag}-${Date.now()}`;
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
    this.scheduleChatTimers();
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

    // Chat onsets are likewise recomputed on resume; the fallback timer for an
    // open chat keeps its remaining window frozen so paused time doesn't count.
    this.chatTimers.forEach(clearTimeout);
    this.chatTimers = [];
    if (this.chatFallbackTimer && this.chatFallbackDeadline != null) {
      this.chatFallbackRemainingMs = Math.max(0, this.chatFallbackDeadline - Date.now());
      clearTimeout(this.chatFallbackTimer);
      this.chatFallbackTimer = null;
    }
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

    this.scheduleChatTimers();
    if (this.activeChat && this.chatFallbackRemainingMs != null) {
      this.armChatFallback(this.chatFallbackRemainingMs);
      this.chatFallbackRemainingMs = null;
    }

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
    this.chatTimers.forEach(clearTimeout);
    if (this.chatFallbackTimer) clearTimeout(this.chatFallbackTimer);
  }

  // ------------------------------------------------------------------ //
  //  Live-chat client reports                                            //
  // ------------------------------------------------------------------ //

  /** Participant accepted the open chat. Returns false for a stale/foreign id. */
  chatAccepted(chatId: string, reactionTimeMs: number): boolean {
    if (!this.activeChat || this.activeChat.chatId !== chatId) return false;
    this.clearOpenChat();
    this.chatsAccepted++;
    if (Number.isFinite(reactionTimeMs) && reactionTimeMs >= 0) {
      this.reactionTimesMs.push(reactionTimeMs);
    }
    this.onEvent({ kind: 'chatAccepted', chatId, reactionTimeMs });
    return true;
  }

  /** Client reported the open chat timed out. Returns false for a stale id. */
  chatMissedByClient(chatId: string): boolean {
    if (!this.activeChat || this.activeChat.chatId !== chatId) return false;
    this.registerMiss(chatId, 'clientTimeout');
    return true;
  }

  /** Click on "Annehmen" with no chat open — logged as a monitoring error. */
  chatFalseClick(): void {
    this.falseClicks++;
  }

  private registerMiss(chatId: string, reason: ChatMissReason): void {
    this.clearOpenChat();
    this.chatsMissed++;
    this.onEvent({ kind: 'chatMissed', chatId, reason, lostCustomers: this.chatsMissed });
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

  /**
   * Arm one timer per not-yet-due chat onset. Recomputed from elapsed active
   * time on begin and resume, so onsets already in the past are skipped —
   * exactly like the rule timers.
   */
  private scheduleChatTimers(): void {
    if (!this.chatEnabled || this.chatSchedule.length === 0) return;

    const elapsed = this.elapsedActiveMs;
    this.chatSchedule.forEach((atSecond, index) => {
      const remainingMs = atSecond * 1000 - elapsed;
      if (remainingMs <= 0) return; // already fired (resolved, or open via activeChat)

      const timer = setTimeout(() => {
        if (this.status !== 'running') return;
        this.showChat(index, atSecond);
      }, remainingMs);
      this.chatTimers.push(timer);
    });
  }

  private showChat(index: number, scheduledOnsetSec: number): void {
    // Onsets are >=17 s apart and a chat resolves within ~7 s, so two never
    // overlap; skip rather than stack if a previous chat is somehow still open.
    if (this.activeChat) return;
    const chatId = `chat-${index + 1}`;
    this.activeChat = { chatId };
    this.chatsShown++;
    // Fallback: if the client never reports back, declare the miss ourselves.
    this.armChatFallback(this.chatTimeoutMs + CHAT_FALLBACK_GRACE_MS);
    this.onEvent({ kind: 'chatShow', chatId, scheduledOnsetSec });
  }

  private armChatFallback(ms: number): void {
    this.chatFallbackDeadline = Date.now() + ms;
    this.chatFallbackTimer = setTimeout(() => {
      if (this.status !== 'running' || !this.activeChat) return;
      this.registerMiss(this.activeChat.chatId, 'noClientResponse');
    }, ms);
  }

  private clearOpenChat(): void {
    if (this.chatFallbackTimer) {
      clearTimeout(this.chatFallbackTimer);
      this.chatFallbackTimer = null;
    }
    this.chatFallbackDeadline = null;
    this.chatFallbackRemainingMs = null;
    this.activeChat = null;
  }

  /** Mean reaction time over accepted chats, or null if none were accepted. */
  get meanReactionTimeMs(): number | null {
    if (this.reactionTimesMs.length === 0) return null;
    const sum = this.reactionTimesMs.reduce((a, b) => a + b, 0);
    return sum / this.reactionTimesMs.length;
  }

  private scheduleSessionTimer(ms?: number): void {
    if (ms == null || ms <= 0) return;

    this.sessionTimer = setTimeout(() => {
      if (this.status !== 'running') return;
      this.onEvent({ kind: 'timerExpired' });
    }, ms);
  }
}
