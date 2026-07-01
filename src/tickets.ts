import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Ticket } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TicketFile {
  tickets: Ticket[];
}

const ticketData: TicketFile = JSON.parse(
  readFileSync(join(__dirname, '../data/tickets.json'), 'utf-8'),
);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function getTicketPool(): Ticket[] {
  return shuffle(ticketData.tickets);
}

export interface DispatchOptions {
  pool: Ticket[];
  intervalMs: number;
  onTicket: (ticket: Ticket) => void;
  onExhausted?: () => void;
}

export function startTicketDispatch({
  pool,
  intervalMs,
  onTicket,
  onExhausted,
}: DispatchOptions): ReturnType<typeof setInterval> {
  let index = 0;

  const timer = setInterval(() => {
    if (index >= pool.length) {
      clearInterval(timer);
      onExhausted?.();
      return;
    }
    onTicket(pool[index++]);
  }, intervalMs);

  return timer;
}
