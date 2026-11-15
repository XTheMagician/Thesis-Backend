// ------------------------------------------------------------------ //
//  AI-capacity bar (hard condition only)                               //
//                                                                      //
//  A bar on the participant's screen fills up in small, irregular      //
//  steps. Once it is full, the AI is overloaded: every ticket that     //
//  would go to the AI must go to human support instead (with teams,    //
//  to the team matching the surname). After OVERLOAD_MS the bar resets //
//  to 0 and starts filling again.                                      //
//                                                                      //
//  Like the live-chat onsets, this is a controlled stimulus: the steps //
//  look random but come from a fixed seed, so every participant and     //
//  both agent runs see exactly the same sequence.                      //
// ------------------------------------------------------------------ //

/** How long the AI stays overloaded before the bar resets. */
export const OVERLOAD_MS = 10_000;

/**
 * Seconds after task:started at which the bar reaches 100 %. Five
 * overloads in the default 5-minute session; each fill (from 0, or from
 * the previous reset) takes 30–70 s: 66, 43, 41, 35, 41 s. Each 10 s
 * overload window is kept clear of the built-in rule changes
 * (50/100/150/200/250 s) and of open live chats (onset + 5 s timeout,
 * see liveChat.ts). Changing these times? Keep both constraints.
 */
export const OVERLOAD_AT_SEC: readonly number[] = [66, 119, 170, 215, 266];

/** Seconds between two fill steps: drawn from this range */
const STEP_GAP_SEC = { min: 2, max: 4 };

/** Fixed seed: change it to get a different (but again fixed) sequence. */
const SEED = 20261116;

export interface CapacityEvent {
  /** Milliseconds after task:started */
  atMs: number;
  /** Fill level, 0–100 */
  level: number;
  /** True while the AI is overloaded (level 100, until the reset) */
  full: boolean;
}

/** mulberry32: tiny deterministic PRNG, uniform in [0, 1) */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The full timeline: fill steps up to each overload, the overload itself,
 * and the reset OVERLOAD_MS later. Step sizes vary (weights 1–3) and are
 * scaled so the bar reaches exactly 100 at each OVERLOAD_AT_SEC.
 */
function buildSchedule(): CapacityEvent[] {
  const rand = seededRandom(SEED);
  const events: CapacityEvent[] = [];
  let cycleStartMs = 0;

  for (const fullAtSec of OVERLOAD_AT_SEC) {
    const fullAtMs = fullAtSec * 1000;

    // Step times between the start of this cycle and the overload
    const stepTimes: number[] = [];
    let t = cycleStartMs;
    for (;;) {
      t += Math.round((STEP_GAP_SEC.min + rand() * (STEP_GAP_SEC.max - STEP_GAP_SEC.min)) * 1000);
      if (t >= fullAtMs - STEP_GAP_SEC.min * 1000) break;
      stepTimes.push(t);
    }

    // Irregular increments that add up to just under 100; the last step
    // (at the overload) tops the bar off
    const weights = stepTimes.map(() => 1 + rand() * 2);
    const total = weights.reduce((a, b) => a + b, 0) + 1.5; // + room for the final step
    let level = 0;
    stepTimes.forEach((atMs, i) => {
      level += (weights[i] / total) * 100;
      events.push({ atMs, level: Math.min(99, Math.round(level)), full: false });
    });

    events.push({ atMs: fullAtMs, level: 100, full: true });
    events.push({ atMs: fullAtMs + OVERLOAD_MS, level: 0, full: false });
    cycleStartMs = fullAtMs + OVERLOAD_MS;
  }
  return events;
}

export const CAPACITY_SCHEDULE: readonly CapacityEvent[] = buildSchedule();
