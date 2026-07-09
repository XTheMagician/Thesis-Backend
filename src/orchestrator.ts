import { Session, type SessionEvent } from './task/session';
import { getTicketPool } from './task/tickets';
import { resolveRobotConfig } from './config/conditions';
import { logEvent, logRobotEvent, closeSession, type LogMeta } from './logger';
import type { Hub } from './hub';
import type { DialogManager } from './robot/dialog-manager';
import type {
  Decision,
  RobotCondition,
  RuleScheduleEntry,
  SortResult,
  TaskCondition,
} from './types';

/**
 * Lifecycle hooks for stateful subsystems (voice-provider session, dialog
 * manager, small-talk scheduler, …). Subsystems register once at boot and
 * get notified on every session transition instead of being wired through
 * the message router.
 */
export interface Subsystem {
  name: string;
  onSessionStart?(session: Session): void;
  onSessionPause?(session: Session): void;
  onSessionResume?(session: Session): void;
  onSessionEnd?(session: Session): void;
}

export interface StartParams {
  participantId: string;
  taskCondition: TaskCondition;
  robotCondition: RobotCondition;
  ticketIntervalMs?: number;
  ticketJitter?: number;
  sessionTimerMs?: number;
  ruleSchedule?: RuleScheduleEntry[];
}

type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Owns the active session and its full lifecycle. All logging and
 * broadcasting of session/task events happens here; the ws-router only
 * validates messages and delegates.
 */
export class Orchestrator {
  private activeSession: Session | null = null;
  private subsystems: Subsystem[] = [];

  constructor(private hub: Hub, private dialog: DialogManager) {
    this.wireRobotLogging();
  }

  /**
   * Robot events (state transitions, transcripts, speech requests) go into
   * the active session's JSONL log — the fixed-column CSV has no place for
   * them. Manual voice tests outside a session are not logged.
   */
  private wireRobotLogging(): void {
    const meta = (): LogMeta | null =>
      this.activeSession ? this.logMeta(this.activeSession) : null;

    this.dialog.onTransition = (from, to, reason) => {
      const m = meta();
      if (m) logRobotEvent(m, 'robot:state', { from, to, reason });
    };

    // Injected lines are skipped here: the 'fired' speech request below
    // records the same content with structured fields.
    this.dialog.onTranscript = (role, text) => {
      const m = meta();
      if (m && role !== 'injected') logRobotEvent(m, 'robot:transcript', { role, text });
    };

    this.dialog.onSpeechRequest = (request, disposition, waitedMs) => {
      const m = meta();
      if (m) {
        logRobotEvent(m, 'robot:speech:request', {
          source: request.source,
          mode: request.mode,
          priority: request.priority ?? 'normal',
          disposition,
          waitedMs,
          text: request.text,
        });
      }
    };
  }

  register(subsystem: Subsystem): void {
    this.subsystems.push(subsystem);
  }

  get session(): Session | null {
    return this.activeSession;
  }

  // ------------------------------------------------------------------ //
  //  Lifecycle                                                            //
  // ------------------------------------------------------------------ //

  startSession(params: StartParams): Result<Session> {
    if (this.activeSession && this.activeSession.status !== 'ended') {
      return { ok: false, error: 'A session is already running.' };
    }

    const robotConfig = resolveRobotConfig(params.robotCondition);
    const intervalMs =
      params.ticketIntervalMs ?? parseInt(process.env.TICKET_INTERVAL_MS ?? '8000');

    const session = new Session({
      participantId: params.participantId,
      taskCondition: params.taskCondition,
      robotCondition: params.robotCondition,
      robotConfig,
      ticketIntervalMs: intervalMs,
      ticketJitter: params.ticketJitter,
      sessionTimerMs: params.sessionTimerMs,
      ticketPool: getTicketPool(),
      ruleSchedule: params.ruleSchedule,
      onEvent: (event) => this.handleSessionEvent(event),
    });
    this.activeSession = session;

    // The resolved robot config goes into the log so every session records
    // the exact treatment the participant received.
    logEvent(this.logMeta(session), 'session:started', { robotConfig });

    this.hub.broadcast({
      type: 'session:started',
      sessionId: session.id,
      participantId: session.participantId,
      condition: session.taskCondition, // legacy field, kept for existing clients
      taskCondition: session.taskCondition,
      robotCondition: session.robotCondition,
      rules: session.activeRules,
      robotConfig,
      ticketIntervalMs: session.ticketIntervalMs,
      ticketJitter: session.ticketJitter,
      timerDurationMs: session.sessionTimerMs,
      startedAt: session.startedAt,
    });

    session.begin();
    this.notify('onSessionStart', session);

    console.log(`[Session] Started: ${session.id}`);
    return { ok: true, value: session };
  }

  pauseSession(): Result {
    const session = this.activeSession;
    if (!session || session.status !== 'running') {
      return { ok: false, error: 'No running session to pause.' };
    }

    session.pause();
    this.notify('onSessionPause', session);

    logEvent(this.logMeta(session), 'session:paused');
    this.hub.broadcast({ type: 'session:paused', sessionId: session.id });

    console.log(`[Session] Paused: ${session.id}`);
    return { ok: true, value: undefined };
  }

  resumeSession(): Result {
    const session = this.activeSession;
    if (!session || session.status !== 'paused') {
      return { ok: false, error: 'No paused session to resume.' };
    }

    const remainingMs = session.resume();
    this.notify('onSessionResume', session);

    logEvent(this.logMeta(session), 'session:resumed');
    this.hub.broadcast({ type: 'session:resumed', sessionId: session.id, remainingMs });

    console.log(`[Session] Resumed: ${session.id}`);
    return { ok: true, value: undefined };
  }

  endSession(): Result {
    const session = this.activeSession;
    if (!session || session.status === 'ended') {
      return { ok: false, error: 'No active session.' };
    }

    session.end();
    this.notify('onSessionEnd', session);

    const accuracy = computeAccuracy(session.stats.correct, session.stats.total);

    logEvent(this.logMeta(session), 'session:ended', {
      totalProcessed: session.stats.total,
      totalCorrect: session.stats.correct,
      totalWrong: session.stats.wrong,
      accuracy,
      sessionDurationMs: session.duration ?? undefined,
    });

    closeSession(session.id);

    this.hub.broadcast({
      type: 'session:ended',
      sessionId: session.id,
      stats: { ...session.stats, accuracy },
      durationMs: session.duration,
    });

    this.activeSession = null;
    console.log(`[Session] Ended: ${session.id}`);
    return { ok: true, value: undefined };
  }

  // ------------------------------------------------------------------ //
  //  Task actions                                                         //
  // ------------------------------------------------------------------ //

  sortTicket(ticketId: string, decision: Decision): Result<SortResult> {
    const session = this.activeSession;
    if (!session || session.status !== 'running') {
      return { ok: false, error: 'No active session.' };
    }

    const outcome = session.sort(ticketId, decision);
    if (!outcome) {
      return { ok: false, error: `Ticket ${ticketId} not found in queue.` };
    }

    const { result } = outcome;
    const accuracy = computeAccuracy(session.stats.correct, session.stats.total);

    logEvent(this.logMeta(session), 'ticket:sorted', {
      ticketId: result.ticketId,
      ticketCategory: result.ticketCategory,
      decision: result.decision,
      correct: result.correct,
      activeRules: result.activeRules,
      timeInQueueMs: result.timeInQueueMs,
      totalProcessed: session.stats.total,
      totalCorrect: session.stats.correct,
      totalWrong: session.stats.wrong,
      accuracy,
    });

    this.hub.broadcast({
      type: 'ticket:sorted',
      ticketId,
      decision,
      correct: result.correct,
      stats: { ...session.stats, accuracy },
      queueLength: session.queue.length,
    });

    return { ok: true, value: result };
  }

  statusPayload(): object {
    const session = this.activeSession;
    return session && session.status !== 'ended'
      ? {
          type: 'session:status',
          status: session.status,
          sessionId: session.id,
          participantId: session.participantId,
          condition: session.taskCondition, // legacy field, kept for existing clients
          taskCondition: session.taskCondition,
          robotCondition: session.robotCondition,
          rules: session.activeRules,
          robotConfig: session.robotConfig,
          stats: session.stats,
          queue: session.queue,
          ticketIntervalMs: session.ticketIntervalMs,
          ticketJitter: session.ticketJitter,
          timerDurationMs: session.sessionTimerMs,
          startedAt: session.startedAt,
          totalPausedMs: session.totalPausedMs,
          pausedAt: session.pausedAt,
        }
      : { type: 'session:status', status: 'idle' };
  }

  // ------------------------------------------------------------------ //
  //  Internals                                                            //
  // ------------------------------------------------------------------ //

  private handleSessionEvent(event: SessionEvent): void {
    const session = this.activeSession;
    if (!session) return;

    switch (event.kind) {
      case 'ticketQueued':
        logEvent(this.logMeta(session), 'ticket:queued', {
          ticketId: event.ticket.id,
          ticketCategory: event.ticket.category,
        });
        this.hub.broadcast({ type: 'ticket:queued', ticket: event.ticket, queueLength: event.queueLength });
        break;

      case 'rulesChanged':
        logEvent(this.logMeta(session), 'rule:changed', {
          activeRules: event.rules,
          robotSpeech: event.robotSpeech,
        });
        this.hub.broadcast({ type: 'rule:changed', rules: event.rules, robotSpeech: event.robotSpeech });
        // Announcements jump the speech queue but never cut off ongoing speech
        if (event.robotSpeech) {
          this.dialog.requestSpeech({
            text: event.robotSpeech,
            mode: 'verbatim',
            source: 'task-event',
            priority: 'high',
          });
        }
        break;

      case 'poolExhausted':
        this.hub.broadcast({ type: 'session:poolExhausted', sessionId: session.id });
        break;

      case 'timerExpired':
        this.endSession();
        console.log(`[Session] Timer expired — ended: ${session.id}`);
        break;
    }
  }

  private notify(hook: keyof Omit<Subsystem, 'name'>, session: Session): void {
    for (const sub of this.subsystems) {
      try {
        sub[hook]?.(session);
      } catch (err) {
        console.error(`[Orchestrator] Subsystem "${sub.name}" failed in ${hook}:`, err);
      }
    }
  }

  private logMeta(session: Session): LogMeta {
    return {
      sessionId: session.id,
      participantId: session.participantId,
      taskCondition: session.taskCondition,
      robotCondition: session.robotCondition,
    };
  }
}

function computeAccuracy(correct: number, total: number): number {
  return total > 0 ? parseFloat((correct / total).toFixed(3)) : 0;
}
