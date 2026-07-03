import { Session } from './session';
import { getTicketPool, startTicketDispatch } from './tickets';
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

export function handleMessage(ctx: RouterContext): void {
  const { clientId, msg, clients, broadcast, getSession, setSession } = ctx;
  const session = getSession();

  switch (msg.type) {
    // ------------------------------------------------------------------ //
    //  session:start                                                       //
    // ------------------------------------------------------------------ //
    case 'session:start': {
      if (session?.status === 'running') {
        reply(clients, clientId, { type: 'error', message: 'A session is already running.' });
        return;
      }

      const participantId = msg.params?.participantId;
      const condition = msg.params?.condition;
      const ticketIntervalMs = msg.params?.ticketIntervalMs;
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

      const s = new Session({ participantId, condition, ticketIntervalMs: intervalMs, sessionTimerMs });
      setSession(s);

      logEvent(s.id, participantId, condition, 'session:started');

      broadcast({
        type: 'session:started',
        sessionId: s.id,
        participantId,
        condition,
        rules: s.activeRules,
        ticketIntervalMs: intervalMs,
        timerDurationMs: s.sessionTimerMs,
        startedAt: s.startedAt,
      });

      // Start ticket arrival (independent of sorting pace)
      const pool = getTicketPool();
      s._dispatchTimer = startTicketDispatch({
        pool,
        intervalMs,
        onTicket(ticket) {
          s.enqueue(ticket);
          logEvent(s.id, participantId, condition, 'ticket:queued', {
            ticketId: ticket.id,
            ticketCategory: ticket.category,
          });
          broadcast({ type: 'ticket:queued', ticket, queueLength: s.queue.length });
        },
        onExhausted() {
          console.log('[Session] Ticket pool exhausted.');
          broadcast({ type: 'session:poolExhausted', sessionId: s.id });
        },
      });

      // Schedule rule changes — hard condition only
      if (condition === 'hard') {
        for (const entry of ruleSchedule as RuleScheduleEntry[]) {
          const timer = setTimeout(() => {
            const updatedRules = s.applyRules(entry.rules);
            logEvent(s.id, participantId, condition, 'rule:changed', {
              activeRules: updatedRules,
              robotSpeech: entry.robotSpeech ?? null,
            });
            broadcast({
              type: 'rule:changed',
              rules: updatedRules,
              robotSpeech: entry.robotSpeech ?? null,
            });
          }, entry.atSecond * 1000);
          s._ruleTimers.push(timer);
        }
      }

      // Auto-end session when timer expires
      if (s.sessionTimerMs) {
        s._sessionTimer = setTimeout(() => {
          if (s.status !== 'running') return;

          s.end();

          const acc = computeAccuracy(s.stats.correct, s.stats.total);

          logEvent(s.id, s.participantId, s.condition, 'session:ended', {
            totalProcessed: s.stats.total,
            totalCorrect: s.stats.correct,
            totalWrong: s.stats.wrong,
            accuracy: acc,
            sessionDurationMs: s.duration ?? undefined,
          });

          closeSession(s.id);

          broadcast({
            type: 'session:ended',
            sessionId: s.id,
            stats: { ...s.stats, accuracy: acc },
            durationMs: s.duration,
          });

          console.log(`[Session] Timer expired — ended: ${s.id}`);
          setSession(null);
        }, s.sessionTimerMs);
      }

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
    //  session:end                                                         //
    // ------------------------------------------------------------------ //
    case 'session:end': {
      if (!session || session.status !== 'running') {
        reply(clients, clientId, { type: 'error', message: 'No active session.' });
        return;
      }

      session.end();

      const accuracy = computeAccuracy(session.stats.correct, session.stats.total);

      logEvent(session.id, session.participantId, session.condition, 'session:ended', {
        totalProcessed: session.stats.total,
        totalCorrect: session.stats.correct,
        totalWrong: session.stats.wrong,
        accuracy,
        sessionDurationMs: session.duration ?? undefined,
      });

      closeSession(session.id);

      broadcast({
        type: 'session:ended',
        sessionId: session.id,
        stats: { ...session.stats, accuracy },
        durationMs: session.duration,
      });

      console.log(`[Session] Ended: ${session.id}`);
      setSession(null);
      break;
    }

    // ------------------------------------------------------------------ //
    //  session:status — any client can request the current snapshot       //
    // ------------------------------------------------------------------ //
    case 'session:status': {
      const payload = session
        ? {
            type: 'session:status',
            status: session.status,
            sessionId: session.id,
            participantId: session.participantId,
            condition: session.condition,
            rules: session.activeRules,
            stats: session.stats,
            queue: session.queue, // full queue so reconnected clients can rebuild
            timerDurationMs: session.sessionTimerMs,
            startedAt: session.startedAt,
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
