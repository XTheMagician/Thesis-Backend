import type { WebSocket } from 'ws';

// ------------------------------------------------------------------ //
//  Domain types                                                        //
// ------------------------------------------------------------------ //

export type ClientType = 'browser' | 'unity' | 'unknown';

/** 2×2 design, axis 1: task cognitive load */
export type TaskCondition = 'easy' | 'hard';
/** 2×2 design, axis 2: robot talkativeness */
export type RobotCondition = 'talkative' | 'quiet';

export type Decision = 'ai' | 'human';
export type TicketCategory = 'software' | 'shipping' | 'general' | 'accounting' | 'hr' | 'returns';

/**
 * Behaviour settings the robot derives from the robot condition.
 * Presets live in config/conditions.ts so every participant in the same
 * cell gets exactly the same treatment; the resolved config is logged
 * at session start.
 */
export interface RobotConfig {
  systemPrompt: string;
  smallTalkEnabled: boolean;
  responseLength: 'short' | 'long';
  voice: string;
}

export interface Ticket {
  id: string;
  category: TicketCategory;
  subject: string;
  body: string;
}

export interface QueuedTicket extends Ticket {
  queuedAt: number;
}

export type ActiveRules = Record<TicketCategory, Decision>;

export interface RuleScheduleEntry {
  atSecond: number;
  rules: Partial<ActiveRules>;
  robotSpeech?: string;
}

export interface SessionStats {
  total: number;
  correct: number;
  wrong: number;
}

export interface SortResult {
  ticketId: string;
  ticketCategory: TicketCategory;
  decision: Decision;
  correct: boolean;
  activeRules: ActiveRules;
  sortedAt: number;
  timeInQueueMs: number;
}

// ------------------------------------------------------------------ //
//  WebSocket client registry                                           //
// ------------------------------------------------------------------ //

export interface WsClient {
  ws: WebSocket;
  type: ClientType;
}

// ------------------------------------------------------------------ //
//  Inbound message union                                               //
// ------------------------------------------------------------------ //

export interface IdentifyMessage {
  type: 'client:identify';
  clientType?: ClientType;
}

export interface SessionStartMessage {
  type: 'session:start';
  params?: {
    participantId?: string;
    taskCondition?: string;
    robotCondition?: string;
    /** Legacy alias for taskCondition (pre-2×2 clients) */
    condition?: string;
    ticketIntervalMs?: number;
    ticketJitter?: number;
    sessionTimerMs?: number;
    ruleSchedule?: RuleScheduleEntry[];
  };
}

export interface TicketSortMessage {
  type: 'ticket:sort';
  ticketId?: string;
  decision?: string;
}

export interface SessionEndMessage {
  type: 'session:end';
}

export interface SessionPauseMessage {
  type: 'session:pause';
}

export interface SessionResumeMessage {
  type: 'session:resume';
}

export interface SessionStatusMessage {
  type: 'session:status';
}

export interface AvpSpeechDoneMessage {
  type: 'avp:speech:done';
}

export interface TestVoiceStartMessage {
  type: 'test:voice:start';
}

export interface TestVoiceStopMessage {
  type: 'test:voice:stop';
}

export interface TestVoiceInjectMessage {
  type: 'test:voice:inject';
  text?: string;
  mode?: string;
}

export type InboundMessage =
  | IdentifyMessage
  | SessionStartMessage
  | TicketSortMessage
  | SessionEndMessage
  | SessionPauseMessage
  | SessionResumeMessage
  | SessionStatusMessage
  | AvpSpeechDoneMessage
  | TestVoiceStartMessage
  | TestVoiceStopMessage
  | TestVoiceInjectMessage;
