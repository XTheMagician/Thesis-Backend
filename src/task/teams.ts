import type { Customer, HumanTeam, HumanTeamRange } from '../types';

// ------------------------------------------------------------------ //
//  Human support teams (hard condition only)                          //
//                                                                      //
//  Every ticket carries the name of the customer who filed it. In the  //
//  hard condition, tickets for human support must also go to the right //
//  team, chosen by the first letter of the customer's surname. Easy    //
//  sessions have a single human side (no teams), but their tickets    //
//  show a name too, so the ticket cards look the same in both.        //
// ------------------------------------------------------------------ //

/** 1 = no team split (a single "Mensch" button, like easy), 2 or 3 teams by surname */
export type HumanTeamCount = 1 | 2 | 3;
type TeamSplitCount = Exclude<HumanTeamCount, 1>;

export const DEFAULT_HUMAN_TEAM_COUNT: HumanTeamCount = 2;

/** Surname letter ranges per team count (inclusive, A–Z) */
const TEAM_RANGES: Record<TeamSplitCount, HumanTeamRange[]> = {
  2: [
    { team: 'A', from: 'A', to: 'M' },
    { team: 'B', from: 'N', to: 'Z' },
  ],
  3: [
    { team: 'A', from: 'A', to: 'H' },
    { team: 'B', from: 'I', to: 'Q' },
    { team: 'C', from: 'R', to: 'Z' },
  ],
};

export function isHumanTeamCount(val: unknown): val is HumanTeamCount {
  return val === 1 || val === 2 || val === 3;
}

export function isHumanTeam(val: unknown): val is HumanTeam {
  return val === 'A' || val === 'B' || val === 'C';
}

export function teamRanges(count: TeamSplitCount): HumanTeamRange[] {
  return TEAM_RANGES[count];
}

/**
 * The session's human support teams: only in the hard condition, and only
 * with a split (count 2 or 3). null = one human side, no team decision.
 */
export function humanTeamsFor(taskCondition: string, count: HumanTeamCount): HumanTeamRange[] | null {
  return taskCondition === 'hard' && count !== 1 ? teamRanges(count) : null;
}

/** First letter of the surname, umlauts folded to their base letter (Ö → O) */
function initial(lastName: string): string {
  return lastName.trim().charAt(0).toUpperCase().normalize('NFD').charAt(0);
}

export function teamForSurname(lastName: string, ranges: HumanTeamRange[]): HumanTeam | null {
  const letter = initial(lastName);
  return ranges.find((r) => letter >= r.from && letter <= r.to)?.team ?? null;
}

// Surnames start with a plain letter (no umlaut, no "von"/"de" prefix) so
// the team is never ambiguous. Every letter range of both splits is
// covered, including the boundary letters (M/N, H/I, Q/R).
const LAST_NAMES = [
  'Adler', 'Albrecht', 'Arnold',
  'Bauer', 'Becker', 'Braun',
  'Christ', 'Conrad',
  'Dietrich', 'Dreher',
  'Ebert', 'Engel',
  'Fischer', 'Friedrich', 'Fuchs',
  'Gerber', 'Graf', 'Günther',
  'Hartmann', 'Hoffmann', 'Huber',
  'Ilg', 'Imhof',
  'Jäger', 'Jung',
  'Keller', 'Koch', 'Krause',
  'Lange', 'Lorenz', 'Ludwig',
  'Martin', 'Meyer', 'Möller',
  'Nagel', 'Neumann', 'Nowak',
  'Oswald', 'Otto',
  'Peters', 'Pfeiffer', 'Pohl',
  'Quast',
  'Richter', 'Rieger', 'Roth',
  'Schulz', 'Seidel', 'Sommer',
  'Teichmann', 'Thiel', 'Thomas',
  'Ulrich', 'Unger',
  'Vogel', 'Voigt',
  'Wagner', 'Weber', 'Winkler',
  'Ziegler', 'Zimmermann',
];

const FIRST_NAMES = [
  'Anna', 'Ben', 'Clara', 'David', 'Elena', 'Felix', 'Greta', 'Hannah', 'Jonas', 'Julia',
  'Karl', 'Laura', 'Lena', 'Lukas', 'Marie', 'Max', 'Mia', 'Nico', 'Nina', 'Oliver',
  'Paul', 'Paula', 'Sarah', 'Simon', 'Sophie', 'Stefan', 'Tim', 'Tobias', 'Vera', 'Yusuf',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Random customer. The surname is drawn team-first (uniform over the
 * ranges, then uniform within the range), so every team gets about the
 * same share of tickets regardless of how many surnames each range has.
 * `avoidLastName` keeps two consecutive tickets from the same customer.
 */
export function randomCustomer(ranges: HumanTeamRange[], avoidLastName?: string): Customer {
  const range = pick(ranges);
  const inRange = LAST_NAMES.filter((n) => teamForSurname(n, [range]) != null && n !== avoidLastName);
  return { firstName: pick(FIRST_NAMES), lastName: pick(inRange) };
}
