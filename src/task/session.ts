import type {
  ActiveRules,
  Decision,
  HumanTeam,
  HumanTeamRange,
  QueuedTicket,
  RobotCondition,
  RobotConfig,
  RuleScheduleEntry,
  SessionStats,
  SortError,
  SortResult,
  TaskCondition,
  Ticket,
} from '../types';
import { shuffleNoRepeat } from './tickets';
import { initialRules, type CategoryCount } from './categories';
import { DEFAULT_HUMAN_TEAM_COUNT, humanTeamsFor, randomCustomer, teamForSurname, teamRanges, type HumanTeamCount } from './teams';
import { CAPACITY_SCHEDULE, OVERLOAD_MS, type CapacityEvent } from '../config/capacity';
import {
  CHAT_SCHEDULE_SEC,
  CHAT_FALLBACK_GRACE_MS,
  DEFAULT_CHAT_TIMEOUT_MS,
} from '../config/liveChat';

/**
 * Easy condition: a ticket appears no sooner than this long after the
 * previous one appeared (or immediately once it is sorted, whichever is
 * later). Hard has no minimum — the next ticket follows the sort directly.
 */
export const EASY_MIN_TICKET_SPACING_MS = 4000;

/** Why a chat ended up a miss. */
export type ChatMissReason = 'clientTimeout' | 'noClientResponse';

/**
 * Domain events the task engine raises. The orchestrator subscribes and
 * handles logging/broadcasting — the session itself never talks to sockets.
 */
export type SessionEvent =
  | { kind: 'ticketQueued'; ticket: QueuedTicket; queueLength: number }
  | { kind: 'rulesChanged'; rules: ActiveRules; robotSpeech: string | null }
  /** scheduledOnsetSec is null for a chat spawned manually (demo runs). */
  | { kind: 'chatShow'; chatId: string; scheduledOnsetSec: number | null }
  | { kind: 'chatAccepted'; chatId: string; reactionTimeMs: number }
  | { kind: 'chatMissed'; chatId: string; reason: ChatMissReason; lostCustomers: number }
  | { kind: 'capacityChanged'; level: number; full: boolean; wasFull: boolean }
  | { kind: 'timerExpired' };

export interface SessionParams {
  participantId: string;
  taskCondition: TaskCondition;
  robotCondition: RobotCondition;
  robotConfig: RobotConfig;
  categoryCount: CategoryCount;
  /** Human support teams; only used in the hard condition */
  humanTeamCount?: HumanTeamCount;
  sessionTimerMs?: number;
  ticketPool: Ticket[];
  ruleSchedule?: RuleScheduleEntry[];
  /** Rule plan used in the hard condition ("Plan A", "Plan B", a saved preset name or "custom"). */
  rulePresetId?: string;
  /** Live-chat side task (resolved: default on in hard, forced off in easy; always on in demo runs). */
  chatEnabled?: boolean;
  chatTimeoutMs?: number;
  /** AI-capacity bar (resolved like chatEnabled: default on in hard, forced off in easy; always on in demo runs). */
  capacityEnabled?: boolean;
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
  /** Categories per side; only these appear in activeRules and the ticket pool */
  readonly categoryCount: CategoryCount;
  /** Surname ranges of the human support teams (hard); null = one human side (easy) */
  readonly humanTeams: HumanTeamRange[] | null;
  readonly sessionTimerMs: number | null;
  /** Demo run: no briefing, no voice, nothing logged */
  readonly demo: boolean;
  /** Minimum active time between two tickets appearing (easy: 4 s, hard: 0) */
  readonly minTicketSpacingMs: number;

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
  /** Holds exactly one ticket while the task runs: the next one is dispatched as soon as the current one is sorted. */
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

  // AI-capacity bar (hard condition only). The backend owns the fixed
  // schedule; while the bar is full, AI tickets must go to human support.
  readonly capacityEnabled: boolean;
  readonly capacitySchedule: readonly CapacityEvent[];
  capacityLevel = 0;
  capacityFull = false;
  /** Number of overloads (bar reached 100 %) so far */
  overloadCount = 0;
  private capacityTimers: ReturnType<typeof setTimeout>[] = [];
  /** Reset of a manually triggered overload (demo runs); frozen across a pause */
  private manualResetTimer: ReturnType<typeof setTimeout> | null = null;
  private manualResetDeadline: number | null = null;
  private manualResetRemainingMs: number | null = null;

  private readonly onEvent: (event: SessionEvent) => void;
  private ticketPool: Ticket[];
  private readonly ruleSchedule: RuleScheduleEntry[];
  /** Fixed chat onset times (seconds after task start); empty when disabled. */
  readonly chatSchedule: readonly number[];
  /** Counter for manually spawned chats (demo runs), for unique chat ids. */
  private manualChatCount = 0;
  private ticketIndex = 0;
  /** 1-based pass through the pool; the pool is reshuffled and repeated once exhausted */
  private ticketRound = 1;
  /** Keeps two consecutive tickets from having the same customer */
  private lastCustomerLastName: string | undefined;

  private ruleTimers: ReturnType<typeof setTimeout>[] = [];
  /** Pending dispatch while the minimum spacing hasn't elapsed yet (easy) */
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Active time (elapsedActiveMs) at which the last ticket appeared */
  private lastQueuedActiveMs: number | null = null;
  private chatTimers: ReturnType<typeof setTimeout>[] = [];
  private chatFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fallback deadline (epoch ms) for the open chat; restored across pause. */
  private chatFallbackDeadline: number | null = null;
  private chatFallbackRemainingMs: number | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;

  // Remaining time captured on pause so the session timer can be recreated on resume
  private sessionTimerRemainingMs: number | null = null;

  constructor(params: SessionParams) {
    this.participantId = params.participantId;
    this.taskCondition = params.taskCondition;
    this.robotCondition = params.robotCondition;
    this.robotConfig = params.robotConfig;
    this.categoryCount = params.categoryCount;
    this.humanTeams = humanTeamsFor(params.taskCondition, params.humanTeamCount ?? DEFAULT_HUMAN_TEAM_COUNT);
    this.sessionTimerMs = params.sessionTimerMs ?? null;
    // Consecutive tickets never share a category (also across pool rounds)
    this.ticketPool = shuffleNoRepeat(params.ticketPool);
    this.ruleSchedule = params.ruleSchedule ?? [];
    this.demo = params.demo ?? false;
    this.minTicketSpacingMs = params.taskCondition === 'easy' ? EASY_MIN_TICKET_SPACING_MS : 0;
    // Live chat only exists in the hard condition; easy forces it off. Demo
    // runs always show the chat panel (so the UI matches the study), but have
    // no schedule: chats only appear when the admin spawns one (spawnChat).
    this.chatEnabled = this.demo || (params.taskCondition === 'hard' && params.chatEnabled !== false);
    this.chatTimeoutMs = params.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.chatSchedule = this.chatEnabled && !this.demo ? CHAT_SCHEDULE_SEC : [];
    // Like the live chat: always shown in demo runs, but without a schedule —
    // the bar only fills when the admin triggers an overload (fillCapacity)
    this.capacityEnabled = this.demo || (params.taskCondition === 'hard' && params.capacityEnabled !== false);
    this.capacitySchedule = this.capacityEnabled && !this.demo ? CAPACITY_SCHEDULE : [];
    this.onEvent = params.onEvent;

    const tag = this.demo ? '-demo' : '';
    const plan = params.taskCondition === 'hard' ? `-${rulePlanTag(params.rulePresetId)}` : '';
    this.id = `${params.participantId}-${params.taskCondition}${plan}-${params.robotCondition}${tag}-${Date.now()}`;
    this.status = 'briefing';
    this.createdAt = Date.now();
    this.startedAt = this.createdAt;
    this.activeRules = initialRules(this.categoryCount);
  }

  /** End the briefing: show the first ticket and arm the rule/session timers. */
  begin(): void {
    if (this.status !== 'briefing') return;
    this.status = 'running';
    this.startedAt = Date.now();
    this.fillQueue();
    this.scheduleRuleTimers();
    this.scheduleChatTimers();
    this.scheduleCapacityTimers();
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

    // A pending dispatch is recomputed from elapsed active time on resume
    this.clearDispatchTimer();

    // Rule timers are recomputed from elapsed active time on resume
    this.ruleTimers.forEach(clearTimeout);
    this.ruleTimers = [];

    // Chat onsets are likewise recomputed on resume; the fallback timer for an
    // open chat keeps its remaining window frozen so paused time doesn't count.
    this.chatTimers.forEach(clearTimeout);
    this.chatTimers = [];
    this.capacityTimers.forEach(clearTimeout);
    this.capacityTimers = [];
    if (this.manualResetTimer && this.manualResetDeadline != null) {
      this.manualResetRemainingMs = Math.max(0, this.manualResetDeadline - Date.now());
      clearTimeout(this.manualResetTimer);
      this.manualResetTimer = null;
    }
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

    this.fillQueue();
    this.scheduleRuleTimers();

    this.scheduleChatTimers();
    this.scheduleCapacityTimers();
    if (this.manualResetRemainingMs != null) {
      this.armManualReset(this.manualResetRemainingMs);
      this.manualResetRemainingMs = null;
    }
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

    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.clearDispatchTimer();
    this.ruleTimers.forEach(clearTimeout);
    this.chatTimers.forEach(clearTimeout);
    this.capacityTimers.forEach(clearTimeout);
    if (this.manualResetTimer) clearTimeout(this.manualResetTimer);
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

  /** Where a ticket must go right now: its rule, except that an overloaded AI sends AI tickets to humans. */
  expectedSideFor(ticket: QueuedTicket): Decision {
    const side = this.activeRules[ticket.category] ?? 'human';
    return side === 'ai' && this.capacityFull ? 'human' : side;
  }

  /** Expected team for a ticket right now; null if it isn't a team decision. */
  expectedTeamFor(ticket: QueuedTicket): HumanTeam | null {
    if (!this.humanTeams || this.expectedSideFor(ticket) !== 'human') return null;
    return teamForSurname(ticket.customer.lastName, this.humanTeams);
  }

  sort(
    ticketId: string,
    decision: Decision,
    team: HumanTeam | null = null,
  ): { ticket: QueuedTicket; result: SortResult } | null {
    const idx = this.queue.findIndex((t) => t.id === ticketId);
    if (idx === -1) return null;

    const [ticket] = this.queue.splice(idx, 1);
    // A team only counts for human decisions in sessions that have teams
    const chosenTeam = decision === 'human' && this.humanTeams ? team : null;
    const ruleSide = this.activeRules[ticket.category] ?? 'human';
    const expectedSide = this.expectedSideFor(ticket);
    const expectedTeam = this.expectedTeamFor(ticket);
    const overloadRedirect = this.capacityFull && ruleSide === 'ai';
    const error: SortError =
      decision !== expectedSide
        ? overloadRedirect ? 'capacity' : 'side'
        : expectedTeam && chosenTeam !== expectedTeam ? 'team' : 'none';
    const correct = error === 'none';
    const sortedAt = Date.now();

    const result: SortResult = {
      ticketId: ticket.id,
      ticketSourceId: ticket.sourceId,
      ticketCategory: ticket.category,
      decision,
      team: chosenTeam,
      ruleSide,
      expectedSide,
      expectedTeam,
      customer: ticket.customer,
      capacityFull: this.capacityFull,
      overloadRedirect,
      correct,
      error,
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

  /**
   * Dispatch the next ticket if none is waiting. Called on begin, on resume
   * and by the orchestrator right after a sort is logged, so at most one
   * ticket is on screen. The next appears as soon as the previous one is
   * done — in easy, though, no sooner than minTicketSpacingMs (active time)
   * after the previous one appeared.
   */
  fillQueue(): void {
    if (this.status !== 'running' || this.queue.length > 0 || this.dispatchTimer) return;

    const waitMs =
      this.lastQueuedActiveMs == null
        ? 0
        : this.lastQueuedActiveMs + this.minTicketSpacingMs - this.elapsedActiveMs;
    if (waitMs > 0) {
      this.dispatchTimer = setTimeout(() => {
        this.dispatchTimer = null;
        this.fillQueue();
      }, waitMs);
      return;
    }

    if (this.ticketIndex >= this.ticketPool.length) this.startNextRound();

    const source = this.ticketPool[this.ticketIndex++];
    const ticket: QueuedTicket = {
      ...source,
      // Repeated tickets need a unique id so sort() can't hit an earlier copy
      id: this.ticketRound === 1 ? source.id : `${source.id}#${this.ticketRound}`,
      sourceId: source.id,
      queuedAt: Date.now(),
      // Easy sessions have no teams, but names are still balanced over the default split
      customer: randomCustomer(
        this.humanTeams ?? teamRanges(2),
        this.lastCustomerLastName,
      ),
    };
    this.lastCustomerLastName = ticket.customer.lastName;
    this.lastQueuedActiveMs = this.elapsedActiveMs;
    this.queue.push(ticket);
    this.onEvent({ kind: 'ticketQueued', ticket, queueLength: this.queue.length });
  }

  private clearDispatchTimer(): void {
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
  }

  /** Reshuffle the exhausted pool; the next round doesn't start with the last ticket's category. */
  private startNextRound(): void {
    const last = this.ticketPool[this.ticketPool.length - 1];
    this.ticketPool = shuffleNoRepeat(this.ticketPool, last?.category);
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
        this.showChat(`chat-${index + 1}`, atSecond);
      }, remainingMs);
      this.chatTimers.push(timer);
    });
  }

  /**
   * Arm one timer per not-yet-due capacity step. Recomputed from elapsed
   * active time on begin and resume, like the rule and chat timers; the
   * current level and overload state simply carry over a pause.
   */
  private scheduleCapacityTimers(): void {
    if (this.capacitySchedule.length === 0) return;

    const elapsed = this.elapsedActiveMs;
    for (const event of this.capacitySchedule) {
      const remainingMs = event.atMs - elapsed;
      if (remainingMs <= 0) continue; // already applied

      const timer = setTimeout(() => {
        if (this.status !== 'running') return;
        this.setCapacity(event.level, event.full);
      }, remainingMs);
      this.capacityTimers.push(timer);
    }
  }

  /**
   * Fill the bar right now and overload the AI for OVERLOAD_MS (admin
   * button in demo runs), then reset it to 0 — the same as a scheduled
   * overload, just on demand.
   */
  fillCapacity(): { ok: true } | { ok: false; error: string } {
    if (this.status !== 'running') return { ok: false, error: 'The task is not running.' };
    if (!this.capacityEnabled) return { ok: false, error: 'The AI-capacity bar is disabled in this session.' };
    if (this.capacityFull) return { ok: false, error: 'The AI is already overloaded.' };
    this.setCapacity(100, true);
    this.armManualReset(OVERLOAD_MS);
    return { ok: true };
  }

  private armManualReset(ms: number): void {
    this.manualResetDeadline = Date.now() + ms;
    this.manualResetTimer = setTimeout(() => {
      this.manualResetTimer = null;
      this.manualResetDeadline = null;
      if (this.status !== 'running') return;
      this.setCapacity(0, false);
    }, ms);
  }

  private setCapacity(level: number, full: boolean): void {
    const wasFull = this.capacityFull;
    this.capacityLevel = level;
    this.capacityFull = full;
    if (full && !wasFull) this.overloadCount++;
    this.onEvent({ kind: 'capacityChanged', level, full, wasFull });
  }

  /**
   * Open a chat right now, outside the schedule (admin button in demo runs).
   * Returns the chat id, or an error if no chat can be opened at the moment.
   */
  spawnChat(): { ok: true; chatId: string } | { ok: false; error: string } {
    if (this.status !== 'running') return { ok: false, error: 'The task is not running.' };
    if (!this.chatEnabled) return { ok: false, error: 'Live chat is disabled in this session.' };
    if (this.activeChat) return { ok: false, error: 'A chat is already open.' };
    const chatId = `chat-manual-${++this.manualChatCount}`;
    this.showChat(chatId, null);
    return { ok: true, chatId };
  }

  private showChat(chatId: string, scheduledOnsetSec: number | null): void {
    // Onsets are >=17 s apart and a chat resolves within ~7 s, so two never
    // overlap; skip rather than stack if a previous chat is somehow still open.
    if (this.activeChat) return;
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
