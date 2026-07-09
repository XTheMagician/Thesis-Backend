import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Ticket } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TicketFile {
  tickets: Ticket[];
}

const ticketData: TicketFile = JSON.parse(
  readFileSync(join(__dirname, '../../data/tickets.json'), 'utf-8'),
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
