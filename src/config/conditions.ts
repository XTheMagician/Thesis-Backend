import type { RobotCondition, RobotConfig } from '../types';

// ------------------------------------------------------------------ //
//  Per-condition robot behaviour presets                               //
//                                                                      //
//  The experimenter only selects the condition cell at session start   //
//  (e.g. "P07, hard, talkative"); the actual prompts and settings      //
//  live here so every participant in the same cell gets exactly the    //
//  same treatment. The resolved config is written to the session log.  //
// ------------------------------------------------------------------ //

// TODO: replace placeholder prompts with the final study prompts before piloting.
export const ROBOT_CONFIGS: Record<RobotCondition, RobotConfig> = {
  talkative: {
    systemPrompt:
      'Du bist ein freundlicher, gesprächiger Assistenzroboter, der eine Person bei einer ' +
      'Ticket-Sortieraufgabe begleitet. Du plauderst gerne, stellst Rückfragen und ' +
      'antwortest in ganzen, lebhaften Sätzen.',
    smallTalkEnabled: true,
    responseLength: 'long',
    voice: 'default',
  },
  quiet: {
    systemPrompt:
      'Du bist ein zurückhaltender Assistenzroboter, der eine Person bei einer ' +
      'Ticket-Sortieraufgabe begleitet. Du sprichst nur, wenn es nötig ist, und ' +
      'antwortest knapp und sachlich.',
    smallTalkEnabled: false,
    responseLength: 'short',
    voice: 'default',
  },
};

export function resolveRobotConfig(condition: RobotCondition): RobotConfig {
  return ROBOT_CONFIGS[condition];
}
