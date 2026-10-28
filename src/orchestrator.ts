import { Session, type SessionEvent } from './task/session';
import { getTicketPool } from './task/tickets';
import { activeCategories, DEFAULT_CATEGORY_COUNT, isCategoryCount } from './task/categories';
import { BRIEFING_START_TOOL, resolveRobotConfig } from './config/conditions';
import { logEvent, logRobotEvent, closeSession, type LogMeta } from './logger';
import { APP_VERSION, LOG_SCHEMA_VERSION, LOG_USER_TRANSCRIPT_TEXT } from './config/study';
import { regenerateExportsForParticipant } from './export';
import type { Hub } from './hub';
import type { DialogManager } from './robot/dialog-manager';
import type {
  Decision,
  RobotCondition,
  RobotOverrides,
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
  /** Session created — the briefing begins (demo runs go straight on to onTaskStart) */
  onSessionStart?(session: Session): void;
  /** Briefing over — tickets and timers are running from now on */
  onTaskStart?(session: Session): void;
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
  categoryCount?: number;
  sessionTimerMs?: number;
  ruleSchedule?: RuleScheduleEntry[];
  rulePresetId?: string;
  robotOverrides?: RobotOverrides;
  demo?: boolean;
}

/** What ended the briefing: the robot's start tool, the admin panel, or a demo run (no briefing). */
export type TaskStartTrigger = 'robot' | 'admin' | 'demo';

/**
 * Why a session ended, recorded in session:ended.
 * - timeout: the session timer elapsed (a regular, "completed" run)
 * - aborted: ended manually from the admin panel
 * - error:   any other teardown (e.g. server shutdown mid-session)
 */
export type EndReason = 'timeout' | 'aborted' | 'error';

type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Owns the active session and its full lifecycle. All logging and
 * broadcasting of session/task events happens here; the ws-router only
 * validates messages and delegates.
 */
export class Orchestrator {
  private activeSession: Session | null = null;
  private subsystems: Subsystem[] = [];
  // Talkative briefing: the explanation follows the participant's first reply
  private briefingExplanationPending = false;
  // The start tool is only honoured once the participant has spoken after
  // the robot's latest briefing line — the model sometimes calls it in
  // place of speaking the "Bist du bereit?" line itself
  private participantSpokeSinceBriefingLine = false;
  // When the robot entered 'listening', i.e. the participant started speaking;
  // used to emit user:utterance with a backend-clock start/end on the way out
  private listenStartedAt: number | null = null;

  constructor(private hub: Hub, private dialog: DialogManager) {
    this.wireRobotLogging();

    // Headset (dis)connects during a session explain cut-off robot speech
    this.hub.onClientChange = ({ clientId, clientType, change, reason }) => {
      const session = this.activeSession;
      if (!session || session.demo) return;
      logRobotEvent(this.logMeta(session), `client:${change}`, { clientId, clientType, reason });
    };
  }

  /**
   * Robot events (state transitions, transcripts, speech requests) go into
   * the active session's JSONL log — the fixed-column CSV has no place for
   * them. Manual voice tests outside a session are not logged.
   */
  private wireRobotLogging(): void {
    const meta = (): LogMeta | null =>
      this.activeSession && !this.activeSession.demo ? this.logMeta(this.activeSession) : null;

    this.dialog.onTransition = (from, to, reason) => {
      const now = Date.now();
      // VAD speech start: arrives before the response it triggers, unlike
      // the (asynchronous) input transcript
      if (to === 'listening') {
        this.participantSpokeSinceBriefingLine = true;
        this.listenStartedAt = now;
      }
      const m = meta();
      if (m) logRobotEvent(m, 'robot:state', { from, to, reason });
      // Leaving 'listening' closes a participant utterance. Timestamps come
      // from the backend clock, so the text is never needed to measure it.
      if (from === 'listening' && this.listenStartedAt != null) {
        const startedAt = this.listenStartedAt;
        this.listenStartedAt = null;
        if (m) {
          logRobotEvent(m, 'user:utterance', {
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(now).toISOString(),
            durationMs: now - startedAt,
          });
        }
      }
    };

    // Injected lines are skipped here: the 'fired' speech request below
    // records the same content with structured fields. The participant's
    // transcribed text is only logged when LOG_USER_TRANSCRIPT_TEXT is on;
    // the event itself (and its timing via user:utterance) is always kept.
    this.dialog.onTranscript = (role, text) => {
      const m = meta();
      if (m && role !== 'injected') {
        const fields = role === 'user' && !LOG_USER_TRANSCRIPT_TEXT ? { role } : { role, text };
        logRobotEvent(m, 'robot:transcript', fields);
      }
      if (role === 'user') this.continueBriefing();
    };

    // A reply the provider generated on its own after the participant spoke
    // (no speech request behind it) — tagged so every spoken robot utterance
    // is attributable to a source.
    this.dialog.onReply = () => {
      const m = meta();
      if (m) logRobotEvent(m, 'robot:reply', { source: 'reply' });
    };

    this.dialog.onSpeechRequest = (request, disposition, waitedMs) => {
      if (request.source === 'briefing' && disposition === 'fired') this.participantSpokeSinceBriefingLine = false;
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

    // Barge-in attempts against protected announcements: the robot keeps
    // talking, but interrupting a rule announcement is a participant error
    // worth its own line in the analysis.
    this.dialog.onInterruptionIgnored = (request) => {
      const m = meta();
      if (m) logRobotEvent(m, 'robot:interruption:ignored', { source: request.source, text: request.text });
    };

    // The participant said they are ready — the robot ends the briefing
    this.dialog.onToolCall = (name) => {
      if (name !== BRIEFING_START_TOOL) return { ok: false, error: `Unbekannte Funktion "${name}".` };

      // Premature call — the dialog manager retries the verbatim line the
      // model skipped, and the result tells the model to wait for the answer
      if (this.activeSession?.status === 'briefing' && !this.participantSpokeSinceBriefingLine) {
        console.log(`[Session] rejected ${name}: participant has not answered yet`);
        const m = meta();
        if (m) logRobotEvent(m, 'robot:tool:rejected', { name, reason: 'participant has not answered yet' });
        return {
          ok: false,
          error: 'Der Teilnehmer hat noch nicht geantwortet. Die Aufgabe startet erst, wenn er bestätigt, dass er bereit ist.',
        };
      }

      const result = this.beginTask('robot');
      if (!result.ok) console.log(`[Session] ignored ${name}: ${result.error}`);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
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

    const categoryCount = isCategoryCount(params.categoryCount) ? params.categoryCount : DEFAULT_CATEGORY_COUNT;
    const robotConfig = resolveRobotConfig(params.robotCondition, params.robotOverrides, categoryCount);
    const intervalMs =
      params.ticketIntervalMs ?? parseInt(process.env.TICKET_INTERVAL_MS ?? '8000');

    const session = new Session({
      participantId: params.participantId,
      taskCondition: params.taskCondition,
      robotCondition: params.robotCondition,
      robotConfig,
      ticketIntervalMs: intervalMs,
      ticketJitter: params.ticketJitter,
      categoryCount,
      sessionTimerMs: params.sessionTimerMs,
      ticketPool: getTicketPool(activeCategories(categoryCount)),
      ruleSchedule: params.ruleSchedule,
      demo: params.demo,
      onEvent: (event) => this.handleSessionEvent(event),
    });
    this.activeSession = session;

    // Resolved task parameters as actually used this session (after admin
    // overrides and env defaults) — the export reads these, not the defaults.
    const taskConfig = {
      taskCondition: session.taskCondition,
      ticketIntervalMs: session.ticketIntervalMs,
      ticketJitter: session.ticketJitter,
      durationMs: session.sessionTimerMs,
      rulePresetId: params.rulePresetId ?? (session.taskCondition === 'easy' ? 'none' : 'custom'),
      categoryCount: session.categoryCount,
    };

    // The resolved robot config and task config go into the log so every
    // session records the exact treatment the participant received.
    this.log(session, 'session:started', {
      schemaVersion: LOG_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      taskConfig,
      robotConfig,
    });

    this.hub.broadcast({
      type: 'session:started',
      sessionId: session.id,
      participantId: session.participantId,
      condition: session.taskCondition, // legacy field, kept for existing clients
      taskCondition: session.taskCondition,
      robotCondition: session.robotCondition,
      rules: session.activeRules,
      robotConfig,
      status: session.status,
      demo: session.demo,
      ticketIntervalMs: session.ticketIntervalMs,
      ticketJitter: session.ticketJitter,
      categoryCount: session.categoryCount,
      timerDurationMs: session.sessionTimerMs,
      startedAt: session.startedAt,
    });

    // Starts the voice session (not in demo runs)
    this.notify('onSessionStart', session);
    console.log(`[Session] Started: ${session.id}`);

    this.briefingExplanationPending = !session.demo && robotConfig.briefingExplanation.length > 0;
    if (session.demo) {
      this.beginTask('demo');
    } else {
      // Queued until the voice session is ready; the scripted rest of the
      // briefing follows from the system prompt
      this.dialog.requestSpeech({
        text: robotConfig.briefingOpener,
        mode: 'verbatim',
        source: 'briefing',
        priority: 'high',
      });
    }
    return { ok: true, value: session };
  }

  /**
   * The participant answered the opener (normally with their name): queue
   * the scripted explanation. It plays once the robot's own reply to the
   * name has finished.
   */
  private continueBriefing(): void {
    const session = this.activeSession;
    if (!this.briefingExplanationPending || session?.status !== 'briefing') return;
    this.briefingExplanationPending = false;
    this.dialog.requestSpeech({
      text: session.robotConfig.briefingExplanation,
      mode: 'verbatim',
      source: 'briefing',
      priority: 'high',
    });
  }

  /**
   * End the briefing and start the task: tickets, rule changes, the session
   * timer and the robot's scheduled speech all count from this moment.
   */
  beginTask(trigger: TaskStartTrigger): Result {
    const session = this.activeSession;
    if (!session || session.status !== 'briefing') {
      return { ok: false, error: 'No session in briefing.' };
    }

    const briefingDurationMs = Date.now() - session.createdAt;
    this.briefingExplanationPending = false;
    session.begin();

    if (!session.demo) {
      // The start tool must not fire a second time mid-task
      this.dialog.setTools([]);
      this.dialog.addContext('[SYSTEM] Die Einführung ist beendet, die Aufgabe läuft jetzt.');
      this.dialog.requestSpeech({
        text: session.robotConfig.briefingStartLine,
        mode: 'verbatim',
        source: 'briefing',
        priority: 'high',
      });
    }

    this.log(session, 'task:started', { trigger, briefingDurationMs });
    this.hub.broadcast({
      type: 'session:taskStarted',
      sessionId: session.id,
      trigger,
      startedAt: session.startedAt,
      timerDurationMs: session.sessionTimerMs,
    });

    this.notify('onTaskStart', session);
    console.log(`[Session] Task started (${trigger}) after ${briefingDurationMs}ms briefing: ${session.id}`);
    return { ok: true, value: undefined };
  }

  pauseSession(): Result {
    const session = this.activeSession;
    if (!session || session.status !== 'running') {
      return { ok: false, error: 'No running session to pause.' };
    }

    session.pause();
    this.notify('onSessionPause', session);

    this.log(session, 'session:paused');
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

    this.log(session, 'session:resumed');
    this.hub.broadcast({ type: 'session:resumed', sessionId: session.id, remainingMs });

    console.log(`[Session] Resumed: ${session.id}`);
    return { ok: true, value: undefined };
  }

  endSession(reason: EndReason = 'aborted'): Result {
    const session = this.activeSession;
    if (!session || session.status === 'ended') {
      return { ok: false, error: 'No active session.' };
    }

    session.end();
    this.notify('onSessionEnd', session);

    const accuracy = computeAccuracy(session.stats.correct, session.stats.total);

    this.log(session, 'session:ended', {
      endReason: reason,
      totalProcessed: session.stats.total,
      totalCorrect: session.stats.correct,
      totalWrong: session.stats.wrong,
      accuracy,
      sessionDurationMs: session.duration ?? undefined,
    });

    const demo = session.demo;
    const participantId = session.participantId;

    this.hub.broadcast({
      type: 'session:ended',
      sessionId: session.id,
      endReason: reason,
      stats: { ...session.stats, accuracy },
      durationMs: session.duration,
    });

    this.activeSession = null;
    console.log(`[Session] Ended (${reason}): ${session.id}`);

    // Flush the JSONL, then rebuild this participant's xlsx and the aggregate
    // from the raw logs. Fire-and-forget: a failing export must never affect
    // the (already finished) session or the logging. Demo runs are not logged.
    if (!demo) {
      void closeSession(session.id)
        .then(() => regenerateExportsForParticipant(participantId))
        .catch((err) => console.error('[Orchestrator] Export after session end failed:', err));
    } else {
      void closeSession(session.id);
    }

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

    this.log(session, 'ticket:sorted', {
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
    // Connection state for the admin panel, independent of any session
    const connections = { ...this.hub.clientsStatus, robotState: this.dialog.currentState };
    return session && session.status !== 'ended'
      ? {
          ...connections,
          type: 'session:status',
          status: session.status,
          sessionId: session.id,
          participantId: session.participantId,
          condition: session.taskCondition, // legacy field, kept for existing clients
          taskCondition: session.taskCondition,
          robotCondition: session.robotCondition,
          rules: session.activeRules,
          robotConfig: session.robotConfig,
          demo: session.demo,
          stats: session.stats,
          queue: session.queue,
          ticketIntervalMs: session.ticketIntervalMs,
          ticketJitter: session.ticketJitter,
      categoryCount: session.categoryCount,
          timerDurationMs: session.sessionTimerMs,
          startedAt: session.startedAt,
          totalPausedMs: session.totalPausedMs,
          pausedAt: session.pausedAt,
        }
      : { ...connections, type: 'session:status', status: 'idle' };
  }

  // ------------------------------------------------------------------ //
  //  Internals                                                            //
  // ------------------------------------------------------------------ //

  private handleSessionEvent(event: SessionEvent): void {
    const session = this.activeSession;
    if (!session) return;

    switch (event.kind) {
      case 'ticketQueued':
        this.log(session, 'ticket:queued', {
          ticketId: event.ticket.id,
          ticketCategory: event.ticket.category,
        });
        this.hub.broadcast({ type: 'ticket:queued', ticket: event.ticket, queueLength: event.queueLength });
        break;

      case 'rulesChanged':
        this.log(session, 'rule:changed', {
          activeRules: event.rules,
          robotSpeech: event.robotSpeech,
        });
        this.hub.broadcast({ type: 'rule:changed', rules: event.rules, robotSpeech: event.robotSpeech });
        // Announcements jump the speech queue but never cut off ongoing
        // speech — and once speaking, participant barge-in can't cut THEM off.
        // Demo runs have no voice session to speak with.
        if (event.robotSpeech && !session.demo) {
          this.dialog.requestSpeech({
            text: event.robotSpeech,
            mode: 'verbatim',
            source: 'task-event',
            priority: 'high',
            uninterruptible: true,
          });
        }
        break;

      case 'timerExpired':
        this.endSession('timeout');
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

  /** Task-event log line (CSV + JSONL). Demo runs are not logged at all. */
  private log(session: Session, eventType: string, fields?: Record<string, unknown>): void {
    if (session.demo) return;
    logEvent(this.logMeta(session), eventType, fields);
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
