import type { Hub } from './hub';
import type { Orchestrator } from './orchestrator';
import type { DialogManager } from './robot/dialog-manager';
import type { Decision, InboundMessage, RobotCondition, RuleScheduleEntry, TaskCondition } from './types';

export interface RouterContext {
  clientId: string;
  msg: InboundMessage;
  hub: Hub;
  orchestrator: Orchestrator;
  dialog: DialogManager;
}

/**
 * Thin dispatch layer: validates inbound JSON messages and delegates to
 * the orchestrator. Session state, logging and broadcasting live there.
 */
export function handleMessage(ctx: RouterContext): void {
  const { clientId, msg, hub, orchestrator, dialog } = ctx;

  switch (msg.type) {
    case 'session:start': {
      const participantId = msg.params?.participantId;
      // `condition` is the legacy alias used by pre-2×2 clients
      const taskCondition = msg.params?.taskCondition ?? msg.params?.condition;
      const robotCondition = msg.params?.robotCondition ?? 'quiet';

      if (!participantId || !isTaskCondition(taskCondition)) {
        hub.sendToClient(clientId, {
          type: 'error',
          message: 'params.participantId and params.taskCondition ("easy"|"hard") are required.',
        });
        return;
      }
      if (!isRobotCondition(robotCondition)) {
        hub.sendToClient(clientId, {
          type: 'error',
          message: 'params.robotCondition must be "talkative" or "quiet".',
        });
        return;
      }

      const result = orchestrator.startSession({
        participantId,
        taskCondition,
        robotCondition,
        ticketIntervalMs: msg.params?.ticketIntervalMs,
        ticketJitter: msg.params?.ticketJitter,
        sessionTimerMs: msg.params?.sessionTimerMs,
        ruleSchedule: msg.params?.ruleSchedule as RuleScheduleEntry[] | undefined,
        robotOverrides: msg.params?.robotOverrides,
      });
      if (!result.ok) hub.sendToClient(clientId, { type: 'error', message: result.error });
      break;
    }

    case 'ticket:sort': {
      const { ticketId, decision } = msg;
      if (!ticketId || !isDecision(decision)) {
        hub.sendToClient(clientId, {
          type: 'error',
          message: 'ticketId and decision ("ai"|"human") are required.',
        });
        return;
      }

      const result = orchestrator.sortTicket(ticketId, decision);
      if (!result.ok) hub.sendToClient(clientId, { type: 'error', message: result.error });
      break;
    }

    case 'session:pause': {
      const result = orchestrator.pauseSession();
      if (!result.ok) hub.sendToClient(clientId, { type: 'error', message: result.error });
      break;
    }

    case 'session:resume': {
      const result = orchestrator.resumeSession();
      if (!result.ok) hub.sendToClient(clientId, { type: 'error', message: result.error });
      break;
    }

    case 'session:end': {
      const result = orchestrator.endSession();
      if (!result.ok) hub.sendToClient(clientId, { type: 'error', message: result.error });
      break;
    }

    case 'session:status': {
      hub.sendToClient(clientId, orchestrator.statusPayload());
      break;
    }

    case 'robot:voice:start': {
      dialog.startVoice();
      break;
    }

    case 'robot:voice:stop': {
      dialog.stopVoice();
      break;
    }

    case 'robot:inject': {
      const text = msg.text?.trim();
      if (!text) {
        hub.sendToClient(clientId, { type: 'error', message: 'text is required for robot:inject.' });
        return;
      }
      dialog.requestSpeech({
        text,
        mode: msg.mode === 'prompt' ? 'prompt' : 'verbatim',
        source: 'admin',
        priority: msg.priority === 'high' ? 'high' : 'normal',
        ttlMs: msg.ttlMs,
      });
      break;
    }

    case 'avp:speech:done': {
      dialog.handlePlaybackDone();
      hub.broadcast({ type: 'avp:speech:done', fromClient: clientId });
      break;
    }

    default: {
      const unknown = msg as unknown as { type: string };
      hub.sendToClient(clientId, { type: 'error', message: `Unknown message type: "${unknown.type}"` });
    }
  }
}

function isTaskCondition(val: unknown): val is TaskCondition {
  return val === 'easy' || val === 'hard';
}

function isRobotCondition(val: unknown): val is RobotCondition {
  return val === 'talkative' || val === 'quiet';
}

function isDecision(val: unknown): val is Decision {
  return val === 'ai' || val === 'human';
}
