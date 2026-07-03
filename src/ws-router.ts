import { Session } from './session';
import { getTicketPool } from './tickets';
import { logEvent, closeSession } from './logger';
import type {
  ActiveRules,
  Condition,
  Decision,
  InboundMessage,
  RuleScheduleEntry,
  WsClient,
} from './types';

export interface RouterContext {
  clientId: string;
  msg: InboundMessage;
  clients: Map<string, WsClient>;
  broadcast: (event: object) => void;
  getSession: () => Session | null;
  setSession: (s: Session | null) => void;
}

// ------------------------------------------------------------------ //
//  Dispatch & timer helpers                                           //
// ------------------------------------------------------------------ //

function scheduleNextTicket(
  s: Session,
  broadcast: (event: object) => void,
  delayMs?: number,
): void {
  if (s._ticketIndex >= s._ticketPool.length) {
    s._dispatchTimer = null;
    console.log('[Session] Ticket pool exhausted.');
    broadcast({ type: 'session:poolExhausted', sessionId: s.id });
    return;
  }

  const delay = delayMs ?? s.randomizedInterval();

  s._dispatchTimer = setTimeout(() => {
    if (s.status !== 'running') return;

    const ticket = s._ticketPool[s._ticketIndex++];
    s._lastDispatchAt = Date.now();
    s.enqueue(ticket);
    logEvent(s.id, s.participantId, s.condition, 'ticket:queued', {
      ticketId: ticket.id,
      ticketCategory: ticket.category,
    });
    broadcast({ type: 'ticket:queued', ticket, queueLength: s.queue.length });

    // Chain the next dispatch
    scheduleNextTicket(s, broadcast);
  }, delay);
}

function scheduleRuleTimers(
  s: Session,
  broadcast: (event: object) => void,
): void {
  if (s.condition !== 'hard' || s._ruleSchedule.length === 0) return;

  const elapsed = s.elapsedActiveMs;

  for (const entry of s._ruleSchedule) {
    const firesAtMs = entry.atSecond * 1000;
    const remainingMs = firesAtMs - elapsed;
    if (remainingMs <= 0) continue; // already fired

    const timer = setTimeout(() => {
      if (s.status !== 'running') return;
      const updatedRules = s.applyRules(entry.rules);
      logEvent(s.id, s.participantId, s.condition, 'rule:changed', {
        activeRules: updatedRules,
        robotSpeech: entry.robotSpeech ?? null,
      });
      broadcast({
        type: 'rule:changed',
        rules: updatedRules,
        robotSpeech: entry.robotSpeech ?? null,
      });
    }, remainingMs);
    s._ruleTimers.push(timer);
  }
}

function scheduleSessionTimer(
  s: Session,
  broadcast: (event: object) => void,
  setSession: (s: Session | null) => void,
  remainingMs?: number,
): void {
  if (s.sessionTimerMs == null) return;

  const ms = remainingMs ?? s.sessionTimerMs;
  if (ms <= 0) return;

  s._sessionTimer = setTimeout(() => {
    if (s.status !== 'running') return;
    endSession(s, broadcast, setSession);
    console.log(`[Session] Timer expired — ended: ${s.id}`);
  }, ms);
}

function endSession(
  s: Session,
  broadcast: (event: object) => void,
  setSession: (s: Session | null) => void,
): void {
  s.end();

  const accuracy = computeAccuracy(s.stats.correct, s.stats.total);

  logEvent(s.id, s.participantId, s.condition, 'session:ended', {
    totalProcessed: s.stats.total,
    totalCorrect: s.stats.correct,
    totalWrong: s.stats.wrong,
    accuracy,
    sessionDurationMs: s.duration ?? undefined,
  });

  closeSession(s.id);

  broadcast({
    type: 'session:ended',
    sessionId: s.id,
    stats: { ...s.stats, accuracy },
    durationMs: s.duration,
  });

  setSession(null);
}

// ------------------------------------------------------------------ //
//  Main message handler                                               //
// ------------------------------------------------------------------ //

export function handleMessage(ctx: RouterContext): void {
  const { clientId, msg, clients, broadcast, getSession, setSession } = ctx;
  const session = getSession();

  switch (msg.type) {
    // ------------------------------------------------------------------ //
    //  session:start                                                       //
    // ------------------------------------------------------------------ //
    case 'session:start': {
      if (session && session.status !== 'ended') {
        reply(clients, clientId, { type: 'error', message: 'A session is already running.' });
        return;
      }

      const participantId = msg.params?.participantId;
      const condition = msg.params?.condition;
      const ticketIntervalMs = msg.params?.ticketIntervalMs;
      const ticketJitter = msg.params?.ticketJitter;
      const sessionTimerMs = msg.params?.sessionTimerMs;
      const ruleSchedule = msg.params?.ruleSchedule ?? [];

      if (!participantId || !isCondition(condition)) {
        reply(clients, clientId, {
          type: 'error',
          message: 'params.participantId and params.condition ("easy"|"hard") are required.',
        });
        return;
      }

      const intervalMs =
        ticketIntervalMs ?? parseInt(process.env.TICKET_INTERVAL_MS ?? '8000');

      const s = new Session({ participantId, condition, ticketIntervalMs: intervalMs, ticketJitter, sessionTimerMs });
      s._ticketPool = getTicketPool();
      s._ruleSchedule = ruleSchedule as RuleScheduleEntry[];
      setSession(s);

      logEvent(s.id, participantId, condition, 'session:started');

      broadcast({
        type: 'session:started',
        sessionId: s.id,
        participantId,
        condition,
        rules: s.activeRules,
        ticketIntervalMs: intervalMs,
        ticketJitter: s.ticketJitter,
        timerDurationMs: s.sessionTimerMs,
        startedAt: s.startedAt,
      });

      scheduleNextTicket(s, broadcast);
      scheduleRuleTimers(s, broadcast);
      scheduleSessionTimer(s, broadcast, setSession);

      console.log(`[Session] Started: ${s.id}`);
      break;
    }

    // ------------------------------------------------------------------ //
    //  ticket:sort                                                         //
    // ------------------------------------------------------------------ //
    case 'ticket:sort': {
      if (!session || session.status !== 'running') {
        reply(clients, clientId, { type: 'error', message: 'No active session.' });
        return;
      }

      const { ticketId, decision } = msg;

      if (!ticketId || !isDecision(decision)) {
        reply(clients, clientId, {
          type: 'error',
          message: 'ticketId and decision ("ai"|"human") are required.',
        });
        return;
      }

      const outcome = session.sort(ticketId, decision);
      if (!outcome) {
        reply(clients, clientId, {
          type: 'error',
          message: `Ticket ${ticketId} not found in queue.`,
        });
        return;
      }

      const { result } = outcome;
      const accuracy = computeAccuracy(session.stats.correct, session.stats.total);

      logEvent(session.id, session.participantId, session.condition, 'ticket:sorted', {
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

      broadcast({
        type: 'ticket:sorted',
        ticketId,
        decision,
        correct: result.correct,
        stats: { ...session.stats, accuracy },
        queueLength: session.queue.length,
      });

      break;
    }

    // ------------------------------------------------------------------ //
    //  session:pause                                                       //
    // ------------------------------------------------------------------ //
    case 'session:pause': {
      if (!session || session.status !== 'running') {
        reply(clients, clientId, { type: 'error', message: 'No running session to pause.' });
        return;
      }

      session.pause();

      logEvent(session.id, session.participantId, session.condition, 'session:paused');

      broadcast({
        type: 'session:paused',
        sessionId: session.id,
      });

      console.log(`[Session] Paused: ${session.id}`);
      break;
    }

    // ------------------------------------------------------------------ //
    //  session:resume                                                      //
    // ------------------------------------------------------------------ //
    case 'session:resume': {
      if (!session || session.status !== 'paused') {
        reply(clients, clientId, { type: 'error', message: 'No paused session to resume.' });
        return;
      }

      const dispatchDelay = session._dispatchRemainingMs;
      const sessionTimerRemaining = session._sessionTimerRemainingMs;

      session.resume();

      // Restart dispatch
      scheduleNextTicket(session, broadcast, dispatchDelay ?? undefined);

      // Reschedule unfired rule timers based on elapsed active time
      scheduleRuleTimers(session, broadcast);

      // Restart session timer with remaining time
      if (sessionTimerRemaining != null) {
        scheduleSessionTimer(session, broadcast, setSession, sessionTimerRemaining);
      }

      logEvent(session.id, session.participantId, session.condition, 'session:resumed');

      broadcast({
        type: 'session:resumed',
        sessionId: session.id,
        remainingMs: sessionTimerRemaining,
      });

      console.log(`[Session] Resumed: ${session.id}`);
      break;
    }

    // ------------------------------------------------------------------ //
    //  session:end                                                         //
    // ------------------------------------------------------------------ //
    case 'session:end': {
      if (!session || (session.status !== 'running' && session.status !== 'paused')) {
        reply(clients, clientId, { type: 'error', message: 'No active session.' });
        return;
      }

      endSession(session, broadcast, setSession);
      console.log(`[Session] Ended: ${session.id}`);
      break;
    }

    // ------------------------------------------------------------------ //
    //  session:status — any client can request the current snapshot       //
    // ------------------------------------------------------------------ //
    case 'session:status': {
      const payload = session && session.status !== 'ended'
        ? {
            type: 'session:status',
            status: session.status,
            sessionId: session.id,
            participantId: session.participantId,
            condition: session.condition,
            rules: session.activeRules,
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

      reply(clients, clientId, payload);
      break;
    }

    // ------------------------------------------------------------------ //
    //  avp:speech:done — Unity signals the robot finished speaking        //
    // ------------------------------------------------------------------ //
    case 'avp:speech:done': {
      console.log(`[AVP] Speech done — client ${clientId}`);
      broadcast({ type: 'avp:speech:done', fromClient: clientId });
      break;
    }

    default: {
      const unknown = msg as unknown as { type: string };
      reply(clients, clientId, { type: 'error', message: `Unknown message type: "${unknown.type}"` });
    }
  }
}

// ------------------------------------------------------------------ //
//  Helpers                                                             //
// ------------------------------------------------------------------ //

function reply(clients: Map<string, WsClient>, clientId: string, event: object): void {
  const client = clients.get(clientId);
  if (client?.ws.readyState === 1 /* OPEN */) {
    client.ws.send(JSON.stringify(event));
  }
}

function isCondition(val: unknown): val is Condition {
  return val === 'easy' || val === 'hard';
}

function isDecision(val: unknown): val is Decision {
  return val === 'ai' || val === 'human';
}

function computeAccuracy(correct: number, total: number): number {
  return total > 0 ? parseFloat((correct / total).toFixed(3)) : 0;
}
