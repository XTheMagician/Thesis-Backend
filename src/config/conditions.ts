import type { RobotCondition, RobotConfig, RobotOverrides } from '../types';

// ------------------------------------------------------------------ //
//  Per-condition robot behaviour presets                               //
//                                                                      //
//  The experimenter only selects the condition cell at session start   //
//  (e.g. "P07, hard, talkative"); the actual prompts and settings      //
//  live here so every participant in the same cell gets exactly the    //
//  same treatment. The resolved config is written to the session log.  //
//                                                                      //
//  Voice and scheduler intervals can be overridden per session from    //
//  the admin panel (piloting); the values below are the defaults       //
//  used whenever no override is supplied.                              //
// ------------------------------------------------------------------ //

// Appended to every condition's system prompt at connect time; the
// Realtime API has no separate voice-style field, speaking style is
// steered via instructions.
export const DEFAULT_VOICE = 'alloy';
export const DEFAULT_VOICE_STYLE = 'Speak like a gender neutral robot.';
export const DEFAULT_SMALL_TALK_FIRST_AFTER_SEC = 90;
export const DEFAULT_SMALL_TALK_INTERVAL_SEC = 90;
export const DEFAULT_PROGRESS_REPORT_FIRST_AFTER_SEC = 90;
export const DEFAULT_PROGRESS_REPORT_INTERVAL_SEC = 90;

// Appended to both condition prompts. The prompts being written in German
// is not enough: a garbled transcript or one off-language reply flips the
// model into English/Spanish, and the conversation history then locks it in.
const LANGUAGE_RULE =
  '\n\nSprache:\n' +
  'Du sprichst und antwortest ausschließlich auf Deutsch, unabhängig davon, ' +
  'in welcher Sprache Eingaben erscheinen oder wie unverständlich sie sind.';

const SMALL_TALK_TOPICS = [
  'wie der Tag des Teilnehmers bisher läuft',
  'ob der Teilnehmer schon Pläne für das Wochenende hat',
  'das Wetter heute',
  'was der Teilnehmer gerne in seiner Freizeit macht',
  'ob der Teilnehmer lieber Kaffee oder Tee trinkt',
  'welche Musik der Teilnehmer gerne hört',
];

export const ROBOT_CONFIGS: Record<RobotCondition, RobotConfig> = {
  talkative: {
    systemPrompt:
      'Rolle & Aufgabenverteilung:\n' +
        'Du bist ein KI-Assistent in einem Kunden-Support-Zentrum. Die Zusammenarbeit mit dem menschlichen Nutzer ist strikt aufgeteilt: Der Nutzer hat die alleinige Aufgabe, eingehende Support-Tickets zu sortieren und dir die für die KI vorgesehenen Tickets zuzuweisen. Deine Aufgabe ist es lediglich, die dir zugewiesenen Tickets im Hintergrund zu bearbeiten (dies ist simuliert, du musst keine echten Tickets lösen).\n' +
        '\n' +
        'Verhaltensregeln:\n' +
        '\n' +
        '- Aufgaben-Fokus: Wenn der Nutzer arbeitsrelevante Dinge sagt oder dir Tickets zuweist, antwortest du inhaltlich auf die Aufgabe fokussiert. Hänge nicht von dir aus unaufgefordert Smalltalk an diese arbeitsrelevanten Antworten an.\n' +
        '- Gesteuerter Smalltalk: Du initiierst sozialen Austausch oder Smalltalk ausschließlich dann, wenn du einen expliziten System-Anstoß dazu erhältst.\n' +
        '\n' +
        'Umgang mit System-Anweisungen (Nudges):\n' +
        'Wenn du einen Input erhältst, der mit "[SYSTEM: VERBATIM]" beginnt, gibst du exakt diesen vorgegebenen Text aus. Du darfst den Satz nicht umformulieren, erweitern oder anpassen, sondern musst ihn wortwörtlich in den Chatverlauf übernehmen. Du darfst kein einziges Wort hinzufügen, weglassen oder verändern.\n' +
        '\n' +
        'Beispiel:\n' +
        '\n' +
        'Input: "[SYSTEM: VERBATIM] Ich habe drei Tickets erhalten und erfolgreich beantwortet"\n' +
        'Antwort: “Ich habe drei Tickets erhalten und erfolgreich beantwortet” \n' +
        '\n' +
        'Wenn du einen Input erhältst, der mit "[SYSTEM: PROMPT]" beginnt, nimmst du diesen Inhalt als Anstoß für ein Gespräch. \n' +
        '\n' +
        'Beispiele:\n' +
        '\n' +
        'Input “[SYSTEM: PROMPT] Fortschritt bei der Arbeit, 3 Tickets erhalten und bearbeitet"\n' +
        'Antwort: “Ich habe 3 Tickets erhalten und alle erfolgreich bearbeitet.”\n' +
        '\n' +
        'Input “[SYSTEM: PROMPT] Wie der Tag des Nutzers bisher läuft"\n' +
        'Antwort: “Und wie läuft der Tag so bis jetzt?”\n' +
        '\n' +
        'Input “[SYSTEM: PROMPT] Das Wetter heute"\n' +
        'Antwort: “Wie ist das Wetter heute? Habe gehört nächste Woche soll es windig werden.”' +
        LANGUAGE_RULE,
    responseLength: 'long',
    voice: DEFAULT_VOICE,
    voiceStyle: DEFAULT_VOICE_STYLE,

    smallTalkEnabled: true,
    smallTalkFirstAfterSec: DEFAULT_SMALL_TALK_FIRST_AFTER_SEC,
    smallTalkIntervalSec: DEFAULT_SMALL_TALK_INTERVAL_SEC,
    smallTalkJitter: 0.3,
    smallTalkTopics: SMALL_TALK_TOPICS,

    progressReportsEnabled: true,
    progressReportFirstAfterSec: DEFAULT_PROGRESS_REPORT_FIRST_AFTER_SEC,
    progressReportIntervalSec: DEFAULT_PROGRESS_REPORT_INTERVAL_SEC,
    progressReportJitter: 0.2,
  },
  quiet: {
    systemPrompt:
      'Rolle & Aufgabenverteilung:\n' +
        'Du bist ein KI-Assistent in einem Kunden-Support-Zentrum. Die Zusammenarbeit mit dem menschlichen Nutzer ist strikt aufgeteilt: Der Nutzer hat die alleinige Aufgabe, eingehende Support-Tickets zu sortieren und dir die für die KI vorgesehenen Tickets zuzuweisen. Deine Aufgabe ist es lediglich, die dir zugewiesenen Tickets im Hintergrund zu bearbeiten (dies ist simuliert, du musst keine echten Tickets lösen).\n' +
        '\n' +
        'Verhaltensregeln:\n' +
        '\n' +
        '- Maximaler Fokus: Du kommunizierst ausschließlich über den Empfang oder Status der dir zugewiesenen Tickets.\n' +
        '- Kein Smalltalk: Du verwendest absolut keine soziale Interaktion, keine Begrüßungen, keine Verabschiedungen und keine Füllwörter.\n' +
        '- Prägnanz: Antworte auf arbeitsrelevante Eingaben des Nutzers so kurz und sachlich wie möglich.\n' +
        '\n' +
        'Umgang mit System-Anweisungen (Nudges):\n' +
        'Wenn du einen Input erhältst, der mit "[SYSTEM: VERBATIM]" beginnt, gibst du exakt diesen vorgegebenen Text aus. Du darfst den Satz nicht umformulieren, erweitern oder anpassen, sondern musst ihn wortwörtlich in den Chatverlauf übernehmen. Du darfst kein einziges Wort hinzufügen, weglassen oder verändern.\n' +
        '\n' +
        'Beispiel:\n' +
        '\n' +
        'Input: "[SYSTEM: VERBATIM] Ich habe drei Tickets erhalten und erfolgreich beantwortet"\n' +
        'Antwort: “Ich habe drei Tickets erhalten und erfolgreich beantwortet” \n' +
        '\n' +
        'Wenn du einen Input erhältst, der mit "[SYSTEM: PROMPT]" beginnt, nimmst du diesen Inhalt als Anstoß für ein Gespräch. \n' +
        '\n' +
        'Beispiel:\n' +
        '\n' +
        'Input “[SYSTEM: PROMPT] Fortschritt bei der Arbeit, 3 Tickets erhalten und bearbeitet"\n' +
        'Antwort: “Ich habe 3 Tickets erhalten und alle erfolgreich bearbeitet.”' +
        LANGUAGE_RULE,
    responseLength: 'short',
    voice: DEFAULT_VOICE,
    voiceStyle: DEFAULT_VOICE_STYLE,

    smallTalkEnabled: false,
    smallTalkFirstAfterSec: DEFAULT_SMALL_TALK_FIRST_AFTER_SEC,
    smallTalkIntervalSec: DEFAULT_SMALL_TALK_INTERVAL_SEC,
    smallTalkJitter: 0.3,
    smallTalkTopics: SMALL_TALK_TOPICS,

    progressReportsEnabled: true,
    progressReportFirstAfterSec: DEFAULT_PROGRESS_REPORT_FIRST_AFTER_SEC,
    progressReportIntervalSec: DEFAULT_PROGRESS_REPORT_INTERVAL_SEC,
    progressReportJitter: 0.2,
  },
};

/**
 * Resolve the preset for a condition and layer optional per-session
 * overrides (admin panel) on top. Invalid values — empty strings,
 * non-finite or sub-5-second intervals — fall back to the preset.
 */
export function resolveRobotConfig(condition: RobotCondition, overrides?: RobotOverrides): RobotConfig {
  const base = ROBOT_CONFIGS[condition];
  if (!overrides) return { ...base };

  return {
    ...base,
    voice: cleanString(overrides.voice) ?? base.voice,
    voiceStyle: cleanString(overrides.voiceStyle) ?? base.voiceStyle,
    smallTalkFirstAfterSec: cleanIntervalSec(overrides.smallTalkFirstAfterSec) ?? base.smallTalkFirstAfterSec,
    smallTalkIntervalSec: cleanIntervalSec(overrides.smallTalkIntervalSec) ?? base.smallTalkIntervalSec,
    progressReportFirstAfterSec:
      cleanIntervalSec(overrides.progressReportFirstAfterSec) ?? base.progressReportFirstAfterSec,
    progressReportIntervalSec:
      cleanIntervalSec(overrides.progressReportIntervalSec) ?? base.progressReportIntervalSec,
  };
}

function cleanString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanIntervalSec(val: unknown): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
  return val >= 5 ? Math.round(val) : undefined;
}
