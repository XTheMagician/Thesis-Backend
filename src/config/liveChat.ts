// ------------------------------------------------------------------ //
//  Live-chat side task (hard condition only)                          //
//                                                                      //
//  A small "customer live chat" pops up at pre-generated times. The    //
//  participant has a few seconds to click "Annehmen"; if they miss it, //
//  a "lost customer" is counted. The schedule is a FIXED list so every //
//  participant and both agent runs get the exact same sequence — it is //
//  a controlled stimulus, not random.                                  //
//                                                                      //
//  The frontend owns the reaction-time measurement and the 5 s timeout //
//  (timed from the moment the chat is actually rendered, so network    //
//  latency never enters the reaction time). The backend sends the      //
//  onset, logs, and keeps a fallback timer in case the client never    //
//  reports back.                                                       //
// ------------------------------------------------------------------ //

/**
 * Onset times in seconds after task:started. 12 chats, 17–33 s apart.
 *
 * Kept clear of the rule changes: with the built-in plans (Plan A/B) rules
 * change at 50/100/150/200/250 s, and no onset falls in the window 10 s
 * before to 5 s after any of those. If a different rule preset moves the
 * changes, regenerate this list under the same constraint.
 */
export const CHAT_SCHEDULE_SEC: readonly number[] = [
  18, 38, 60, 82, 112, 131, 163, 181, 209, 226, 259, 281,
];

/** Default time a chat stays open before it counts as a lost customer. */
export const DEFAULT_CHAT_TIMEOUT_MS = 5_000;

/**
 * Extra grace after the timeout before the backend fallback declares a miss
 * on its own — covers a client that rendered the chat but never reported.
 */
export const CHAT_FALLBACK_GRACE_MS = 2_000;

/** Clamp an admin-supplied timeout to a sane range, or fall back to the default. */
export function cleanChatTimeoutMs(val: unknown): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return DEFAULT_CHAT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(1_000, Math.round(val)));
}
