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
}

export class Session {
  readonly id: string;
  readonly participantId: string;
  readonly condition: Condition;
  readonly ticketIntervalMs: number;

  status: 'running' | 'ended';
  readonly startedAt: number;
  endedAt: number | null = null;
  duration: number | null = null;

  activeRules: ActiveRules;
  queue: QueuedTicket[] = [];
  results: SortResult[] = [];
  stats: SessionStats = { total: 0, correct: 0, wrong: 0 };

  // Timer handles for cleanup — managed externally by the router
  _dispatchTimer: ReturnType<typeof setInterval> | null = null;
  _ruleTimers: ReturnType<typeof setTimeout>[] = [];

  constructor({ participantId, condition, ticketIntervalMs }: SessionConstructorParams) {
    this.id = `${participantId}-${condition}-${Date.now()}`;
    this.participantId = participantId;
    this.condition = condition;
    this.ticketIntervalMs = ticketIntervalMs;
    this.status = 'running';
    this.startedAt = Date.now();
    this.activeRules = { ...DEFAULT_RULES };
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

  end(): void {
    this.status = 'ended';
    this.endedAt = Date.now();
    this.duration = this.endedAt - this.startedAt;

    if (this._dispatchTimer) clearInterval(this._dispatchTimer);
    this._ruleTimers.forEach(clearTimeout);
  }
}
