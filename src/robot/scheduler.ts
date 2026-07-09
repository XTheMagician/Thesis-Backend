import type { DialogManager } from './dialog-manager';
import type { Subsystem } from '../orchestrator';
import type { Session } from '../task/session';

// ------------------------------------------------------------------ //
//  Speech scheduler                                                    //
//                                                                      //
//  Orchestrator subsystem that periodically asks the dialog manager    //
//  to make the robot speak. Two independent plans, parameterized per   //
//  condition in config/conditions.ts:                                  //
//                                                                      //
//  - small talk (talkative condition only): opens a conversation       //
//    about the next topic from a per-session shuffled deck — each      //
//    topic is used at most once per session                            //
//  - progress reports (both conditions): the robot-as-AI-agent         //
//    reports on the tickets assigned to it, using live session stats   //
//    read at fire time so the numbers are always current               //
//                                                                      //
//  Collisions are the dialog manager's job: requests queue when the    //
//  robot is busy, and the TTL silently drops impulses that got stale.  //
// ------------------------------------------------------------------ //

const SMALL_TALK_TTL_MS = 30_000;
const PROGRESS_TTL_MS = 45_000;

export class SpeechScheduler implements Subsystem {
  readonly name = 'speech-scheduler';

  private session: Session | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  // Shuffled per session and drawn down — no topic is ever offered twice
  private topicDeck: string[] = [];

  constructor(private dialog: DialogManager) {}

  onSessionStart(session: Session): void {
    this.session = session;
    this.topicDeck = shuffle(session.robotConfig.smallTalkTopics);
    this.scheduleAll();
  }

  onSessionPause(): void {
    this.clearTimers();
  }

  onSessionResume(): void {
    // Fresh intervals rather than remaining time — precise resumption
    // doesn't matter for jittered conversational impulses
    this.scheduleAll();
  }

  onSessionEnd(): void {
    this.clearTimers();
    this.session = null;
  }

  // ------------------------------------------------------------------ //
  //  Plans                                                                //
  // ------------------------------------------------------------------ //

  private scheduleAll(): void {
    this.clearTimers();
    const config = this.session?.robotConfig;
    if (!config) return;

    if (config.smallTalkEnabled && config.smallTalkTopics.length > 0) {
      this.scheduleRecurring(config.smallTalkIntervalSec, config.smallTalkJitter, () => this.fireSmallTalk());
    }
    if (config.progressReportsEnabled) {
      this.scheduleRecurring(config.progressReportIntervalSec, config.progressReportJitter, () => this.fireProgressReport());
    }
  }

  private fireSmallTalk(): void {
    if (!this.session || !this.robotAvailable()) return;

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
    if (!session || !this.robotAvailable()) return;

    // The robot is the "KI-Agent" of the task fiction: report on the
    // tickets the participant has assigned to it so far
    const assigned = session.results.filter((r) => r.decision === 'ai').length;
    if (assigned === 0) return; // nothing to report yet — skip this round

    this.dialog.requestSpeech({
      text:
        `Berichte dem Teilnehmer unaufgefordert und kurz über deinen Arbeitsfortschritt: ` +
        `dir wurden bisher ${assigned} Tickets zugewiesen und du hast sie erfolgreich bearbeitet.`,
      mode: 'prompt',
      source: 'scheduler',
      priority: 'normal',
      ttlMs: PROGRESS_TTL_MS,
    });
  }

  // ------------------------------------------------------------------ //
  //  Timer plumbing                                                       //
  // ------------------------------------------------------------------ //

  /** Chained setTimeout with jitter: base ± (base * jitter), min 5s. */
  private scheduleRecurring(intervalSec: number, jitter: number, fire: () => void): void {
    const delayMs = () => {
      const base = intervalSec * 1000;
      const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter * base : 0;
      return Math.max(5000, Math.round(base + offset));
    };

    const chain = () => {
      const timer = setTimeout(() => {
        if (!this.session || this.session.status !== 'running') return;
        fire();
        chain();
      }, delayMs());
      this.timers.push(timer);
    };
    chain();
  }

  /** Don't spam robot:error while the voice session is down or connecting. */
  private robotAvailable(): boolean {
    const state = this.dialog.currentState;
    return state !== 'offline' && state !== 'connecting';
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
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
