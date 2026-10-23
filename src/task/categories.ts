import type { ActiveRules, Decision, TicketCategory } from '../types';

// ------------------------------------------------------------------ //
//  Ticket categories per session                                       //
//                                                                      //
//  The admin panel picks how many categories each side starts with     //
//  (3 or 4). The 4th category per side is simply left out of the       //
//  smaller set; tickets of inactive categories are never dispatched.   //
// ------------------------------------------------------------------ //

export type CategoryCount = 3 | 4;

export const DEFAULT_CATEGORY_COUNT: CategoryCount = 4;

/** Initial assignment, in display order; the first `count` entries per side are active */
const INITIAL_SIDES: Record<Decision, TicketCategory[]> = {
  ai: ['software', 'shipping', 'general', 'appointments'],
  human: ['accounting', 'hr', 'returns', 'privacy'],
};

/** German labels, as shown to the participant and used in the robot's prompt */
export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  software: 'Software',
  shipping: 'Versand',
  general: 'Allgemein',
  appointments: 'Termine',
  accounting: 'Buchhaltung',
  hr: 'Personal',
  returns: 'Retouren',
  privacy: 'Datenschutz',
};

export function isCategoryCount(val: unknown): val is CategoryCount {
  return val === 3 || val === 4;
}

export function initialSides(count: CategoryCount): Record<Decision, TicketCategory[]> {
  return { ai: INITIAL_SIDES.ai.slice(0, count), human: INITIAL_SIDES.human.slice(0, count) };
}

export function activeCategories(count: CategoryCount): TicketCategory[] {
  const { ai, human } = initialSides(count);
  return [...ai, ...human];
}

export function initialRules(count: CategoryCount): ActiveRules {
  const { ai, human } = initialSides(count);
  return Object.fromEntries([
    ...ai.map((c) => [c, 'ai'] as const),
    ...human.map((c) => [c, 'human'] as const),
  ]) as ActiveRules;
}
