import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Ticket, TicketCategory } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TicketFile {
  tickets: Ticket[];
}

const ticketData: TicketFile = JSON.parse(
  readFileSync(join(__dirname, '../../data/tickets.json'), 'utf-8'),
);

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Shuffled pool of all tickets in the session's active categories */
export function getTicketPool(categories: TicketCategory[]): Ticket[] {
  return shuffle(ticketData.tickets.filter((t) => categories.includes(t.category)));
}

/**
 * Random order in which no two consecutive tickets share a category, also
 * across the boundary to the previous round (`prevCategory`). Each step
 * picks uniformly among the tickets that keep the rest arrangeable; if the
 * pool can't be arranged at all (one category holds more than half of
 * it), the remaining tickets follow in shuffled order.
 */
export function shuffleNoRepeat(tickets: Ticket[], prevCategory?: TicketCategory): Ticket[] {
  const remaining = shuffle(tickets);
  const counts = new Map<TicketCategory, number>();
  for (const t of remaining) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);

  // Can the tickets left after placing one of `cat` still be ordered without a repeat?
  const feasibleAfter = (cat: TicketCategory): boolean => {
    const left = remaining.length - 1;
    for (const [c, n] of counts) {
      const m = c === cat ? n - 1 : n;
      // m tickets of c need m-1 separators; if c was just placed, one more
      const others = left - m;
      if (m > others + (c === cat ? 0 : 1)) return false;
    }
    return true;
  };

  const result: Ticket[] = [];
  let prev = prevCategory;
  while (remaining.length > 0) {
    const idx = remaining.findIndex((t) => t.category !== prev && feasibleAfter(t.category));
    if (idx === -1) return [...result, ...remaining]; // not arrangeable; give up gracefully
    const [ticket] = remaining.splice(idx, 1);
    counts.set(ticket.category, counts.get(ticket.category)! - 1);
    result.push(ticket);
    prev = ticket.category;
  }
  return result;
}
