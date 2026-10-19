import type { DialogManager } from './dialog-manager';
import type { Subsystem } from '../orchestrator';
import type { Session } from '../task/session';

// ------------------------------------------------------------------ //
//  Speech scheduler                                                    //
//                                                                      //
//  Orchestrator subsystem that periodically asks the dialog manager    //
//  to make the robot speak. Both plans start with the task (after the  //
//  briefing, which already covers the introduction) and are            //
//  parameterized per condition in config/conditions.ts:                //
//                                                                      //
//  - small talk (talkative condition only): each impulse opens a       //
//    conversation about the next topic from a per-session shuffled     //
//    deck — each topic is used at most once per session                //
//  - progress reports (both conditions): the robot-as-AI-agent         //
//    reports on the tickets assigned to it, using live session stats   //
//    read at fire time so the numbers are always current. Spoken       //
//    verbatim as one fixed sentence — identical wording for everyone,  //
//    and a single sentence is what the provider's audio reliably       //
//    delivers in full                                                  //
//                                                                      //
//  Impulses never cut into an ongoing conversation: a due impulse      //
//  waits until the conversation has been silent for impulseQuietSec    //
//  (nobody speaking, robot idle). Only then is a topic drawn and the   //
//  request sent — so the dialog manager fires it immediately instead   //
//  of queueing it for the end of the robot's current turn, which is    //
//  exactly when the participant would answer. The next interval        //
//  counts from the actual firing.                                      //
// ------------------------------------------------------------------ //

const SMALL_TALK_TTL_MS = 30_000;
const PROGRESS_TTL_MS = 45_000;
// Re-check cadence while a due impulse waits for the conversation to end
const QUIET_POLL_MS = 1000;

export class SpeechScheduler implements Subsystem {
  readonly name = 'speech-scheduler';

  private session: Session | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  // Shuffled per session and drawn down — no topic is ever offered twice
  private topicDeck: string[] = [];

  constructor(private dialog: DialogManager) {}

  onSessionStart(session: Session): void {
    // Demo runs have no voice session — nothing to schedule
    if (session.demo) return;
    this.session = session;
    this.topicDeck = shuffle(session.robotConfig.smallTalkTopics);
  }

  onTaskStart(): void {
    this.scheduleAll(true);
  }

  onSessionPause(): void {
    this.clearTimers();
  }

  onSessionResume(): void {
    // Fresh intervals rather than remaining time — precise resumption
    // doesn't matter for jittered conversational impulses. The first-after
    // delay only applies to a fresh session, not after a pause.
    this.scheduleAll(false);
  }

  onSessionEnd(): void {
    this.clearTimers();
    this.session = null;
  }

  // ------------------------------------------------------------------ //
  //  Plans                                                                //
  // ------------------------------------------------------------------ //

  private scheduleAll(initial: boolean): void {
    this.clearTimers();
    const config = this.session?.robotConfig;
    if (!config) return;

    if (config.smallTalkEnabled && config.smallTalkTopics.length > 0) {
      this.scheduleRecurring(
        initial ? config.smallTalkFirstAfterSec : config.smallTalkIntervalSec,
        config.smallTalkIntervalSec,
        config.smallTalkJitter,
        () => this.fireSmallTalk(),
      );
    }
    if (config.progressReportsEnabled) {
      this.scheduleRecurring(
        initial ? config.progressReportFirstAfterSec : config.progressReportIntervalSec,
        config.progressReportIntervalSec,
        config.progressReportJitter,
        () => this.fireProgressReport(),
      );
    }
  }

  private fireSmallTalk(): void {
    if (!this.session) return;

    const topic = this.topicDeck.shift();
    if (!topic) {
      console.log('[Scheduler] Small talk topic pool exhausted — no further small talk this session.');
      return;
    }

    this.dialog.requestSpeech({
      text: topic,
      mode: 'prompt',
      source: 'scheduler',
      priority: 'normal',
      ttlMs: SMALL_TALK_TTL_MS,
    });
  }

  private fireProgressReport(): void {
    const session = this.session;
    if (!session) return;

    // The robot is the "KI-Agent" of the task fiction: report on the
    // tickets the participant has assigned to it so far
    const assigned = session.results.filter((r) => r.decision === 'ai').length;
    const correctlyAssigned = session.results.filter((r) => r.decision === 'ai' && r.correct).length;
    if (assigned === 0) return; // nothing to report yet — skip this round

    this.dialog.requestSpeech({
      text: progressReport(assigned, correctlyAssigned),
      mode: 'verbatim',
      source: 'scheduler',
      priority: 'normal',
      ttlMs: PROGRESS_TTL_MS,
    });
  }

  // ------------------------------------------------------------------ //
  //  Timer plumbing                                                       //
  // ------------------------------------------------------------------ //

  /**
   * Chained setTimeout: the first impulse is due after exactly firstDelaySec
   * (min 5s, the voice session needs a moment to connect), every following
   * one intervalSec ± (intervalSec * jitter) after the previous firing.
   * A due impulse fires only once the conversation has been quiet long
   * enough; until then it is re-checked, not dropped.
   */
  private scheduleRecurring(
    firstDelaySec: number,
    intervalSec: number,
    jitter: number,
    fire: () => void,
  ): void {
    const jitteredMs = () => {
      const base = intervalSec * 1000;
      const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter * base : 0;
      return Math.max(5000, Math.round(base + offset));
    };

    const attempt = (dueAt: number) => {
      if (!this.session || this.session.status !== 'running') return;
      const waitMs = this.quietWaitMs();
      if (waitMs > 0) {
        if (dueAt === 0) dueAt = Date.now();
        this.after(Math.max(QUIET_POLL_MS, waitMs), () => attempt(dueAt));
        return;
      }
      if (dueAt > 0) {
        console.log(`[Scheduler] impulse deferred ${Date.now() - dueAt}ms until the conversation went quiet`);
      }
      fire();
      this.after(jitteredMs(), () => attempt(0));
    };
    this.after(Math.max(5000, Math.round(firstDelaySec * 1000)), () => attempt(0));
  }

  /**
   * Remaining wait before an impulse may fire: the conversation must have
   * been silent for impulseQuietSec. While the voice session is down or
   * connecting the robot can't speak at all (and would spam robot:error),
   * so the impulse simply keeps waiting.
   */
  private quietWaitMs(): number {
    const state = this.dialog.currentState;
    if (state === 'offline' || state === 'connecting') return QUIET_POLL_MS;
    const requiredMs = (this.session?.robotConfig.impulseQuietSec ?? 0) * 1000;
    if (state !== 'idle') return Math.max(QUIET_POLL_MS, requiredMs);
    return requiredMs - this.dialog.quietForMs;
  }

  /** setTimeout that forgets its handle once fired, so polling doesn't pile up. */
  private after(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      fn();
    }, delayMs);
    this.timers.push(timer);
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

/** One sentence, so the dialog manager speaks it as a single piece. */
function progressReport(assigned: number, done: number): string {
  const tickets = assigned === 1 ? 'wurde bisher 1 Ticket' : `wurden bisher ${assigned} Tickets`;
  return `Mir ${tickets} zugewiesen, davon habe ich ${done} erfolgreich bearbeitet.`;
}

/** Fisher–Yates, on a copy. */
function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
