import type { RobotCondition, RobotConfig } from '../types';

// ------------------------------------------------------------------ //
//  Per-condition robot behaviour presets                               //
//                                                                      //
//  The experimenter only selects the condition cell at session start   //
//  (e.g. "P07, hard, talkative"); the actual prompts and settings      //
//  live here so every participant in the same cell gets exactly the    //
//  same treatment. The resolved config is written to the session log.  //
//                                                                      //
//  Scheduler parameters are tuned HERE (piloting), never per session:  //
//  smallTalk* is the talkativeness manipulation, progressReport* is    //
//  task-relevant communication and active in both conditions.          //
// ------------------------------------------------------------------ //

const SMALL_TALK_TOPICS = [
  'wie der Tag des Teilnehmers bisher läuft',
  'ob der Teilnehmer schon Pläne für das Wochenende hat',
  'das Wetter heute',
  'was der Teilnehmer gerne in seiner Freizeit macht',
  'ob der Teilnehmer lieber Kaffee oder Tee trinkt',
  'welche Musik der Teilnehmer gerne hört',
];

// TODO: replace placeholder prompts with the final study prompts before piloting.
export const ROBOT_CONFIGS: Record<RobotCondition, RobotConfig> = {
  talkative: {
    systemPrompt:
      'Du bist ein freundlicher, gesprächiger Assistenzroboter, der eine Person bei einer ' +
      'Ticket-Sortieraufgabe begleitet. Du plauderst gerne, stellst Rückfragen und ' +
      'antwortest in ganzen, lebhaften Sätzen.',
    responseLength: 'long',
    voice: 'marin',

    smallTalkEnabled: true,
    smallTalkIntervalSec: 90,
    smallTalkJitter: 0.3,
    smallTalkTopics: SMALL_TALK_TOPICS,

    progressReportsEnabled: true,
    progressReportIntervalSec: 180,
    progressReportJitter: 0.2,
  },
  quiet: {
    systemPrompt:
      'Du bist ein zurückhaltender Assistenzroboter, der eine Person bei einer ' +
      'Ticket-Sortieraufgabe begleitet. Du sprichst nur, wenn es nötig ist, und ' +
      'antwortest knapp und sachlich.',
    responseLength: 'short',
    voice: 'marin',

    smallTalkEnabled: false,
    smallTalkIntervalSec: 90,
    smallTalkJitter: 0.3,
    smallTalkTopics: SMALL_TALK_TOPICS,

    progressReportsEnabled: true,
    progressReportIntervalSec: 180,
    progressReportJitter: 0.2,
  },
};

export function resolveRobotConfig(condition: RobotCondition): RobotConfig {
  return ROBOT_CONFIGS[condition];
}
