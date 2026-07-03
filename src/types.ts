import type { WebSocket } from 'ws';

// ------------------------------------------------------------------ //
//  Domain types                                                        //
// ------------------------------------------------------------------ //

export type ClientType = 'browser' | 'unity' | 'unknown';
export type Condition = 'easy' | 'hard';
export type Decision = 'ai' | 'human';
export type TicketCategory = 'software' | 'shipping' | 'general' | 'accounting' | 'hr' | 'returns';

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
    condition?: string;
    ticketIntervalMs?: number;
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

export interface SessionStatusMessage {
  type: 'session:status';
}

export interface AvpSpeechDoneMessage {
  type: 'avp:speech:done';
}

export type InboundMessage =
  | IdentifyMessage
  | SessionStartMessage
  | TicketSortMessage
  | SessionEndMessage
  | SessionStatusMessage
  | AvpSpeechDoneMessage;
