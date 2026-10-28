import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LOGS_DIR } from './logger';
import { PARTICIPANT_ID_PATTERN } from './config/study';

// ------------------------------------------------------------------ //
//  Analysis export                                                     //
//                                                                      //
//  The JSONL session logs are the single source of truth. This module //
//  reads them and (re)computes, from scratch each time, the xlsx       //
//  analysis files:                                                     //
//    exports/all.xlsx                 — every session / participant    //
//    exports/participants/P###.xlsx   — one participant's rows         //
//                                                                      //
//  Per-participant and aggregate files share one computation           //
//  (computeAnalysis), so they can never disagree. Files are fully      //
//  overwritten on every run; nothing is appended incrementally.        //
//  Numbers are written as real numbers and never rounded.              //
// ------------------------------------------------------------------ //

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXPORTS_DIR = join(__dirname, '../exports');
const PARTICIPANTS_DIR = join(EXPORTS_DIR, 'participants');
export const ALL_EXPORT_FILE = join(EXPORTS_DIR, 'all.xlsx');

interface LogLine {
  timestamp: string;
  sessionId: string;
  participantId: string;
  taskCondition?: string;
  robotCondition?: string;
  eventType: string;
  [key: string]: unknown;
}

interface RawSession {
  sessionId: string;
  participantId: string;
  events: LogLine[];
}

export interface SessionRow {
  participantId: string;
  sessionId: string;
  startedAtUTC: string;
  runIndex: number | null;
  taskCondition: string;
  robotCondition: string;
  rulePresetId: string;
  completed: boolean;
  endReason: string;
  ticketsQueued: number;
  ticketsSorted: number;
  ticketsCorrect: number;
  ticketsIncorrect: number;
  score: number;
  throughput: number | null;
  accuracy: number | null;
  medianHandlingMs: number | null;
  robotSmalltalkCount: number;
  userUtteranceCount: number;
  userSpeakingSec: number;
  // Bookkeeping (not emitted as columns)
  startedAtMs: number;
  hasTaskStarted: boolean;
  hasSessionEnded: boolean;
}

export interface ParticipantRow {
  participantId: string;
  load: string;
  talkFirst: number;
  rulePreset_talk: string;
  rulePreset_quiet: string;
  talk_score: number;
  quiet_score: number;
  talk_throughput: number | null;
  quiet_throughput: number | null;
  talk_accuracy: number | null;
  quiet_accuracy: number | null;
  talk_medianHandlingMs: number | null;
  quiet_medianHandlingMs: number | null;
  talk_robotSmalltalkCount: number;
  quiet_robotSmalltalkCount: number;
  talk_userUtteranceCount: number;
  quiet_userUtteranceCount: number;
  talk_userSpeakingSec: number;
  quiet_userSpeakingSec: number;
  adv_score: number;
  adv_throughput: number | null;
  adv_accuracy: number | null;
  adv_medianHandlingMs: number | null;
}

export interface Hinweis {
  participantId: string;
  sessionId: string;
  grund: string;
}

export interface Analysis {
  sessionRows: SessionRow[];
  participantRows: ParticipantRow[];
  hinweise: Hinweis[];
  participantIds: string[];
}

// ------------------------------------------------------------------ //
//  Reading                                                             //
// ------------------------------------------------------------------ //

function readSessions(): RawSession[] {
  if (!existsSync(LOGS_DIR)) return [];
  const sessions: RawSession[] = [];
  for (const file of readdirSync(LOGS_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    const events: LogLine[] = [];
    const raw = readFileSync(join(LOGS_DIR, file), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as LogLine);
      } catch {
        // Skip a partial/corrupt line (e.g. a crash mid-write)
      }
    }
    if (events.length === 0) continue;
    const sessionId = file.replace(/\.jsonl$/, '');
    const participantId = String(events[0].participantId ?? '');
    sessions.push({ sessionId, participantId, events });
  }
  return sessions;
}

// ------------------------------------------------------------------ //
//  Per-session metrics                                                 //
// ------------------------------------------------------------------ //

function computeSessionRow(raw: RawSession): SessionRow {
  const { events, sessionId, participantId } = raw;

  const started = events.find((e) => e.eventType === 'session:started');
  const taskStarted = events.find((e) => e.eventType === 'task:started');
  const ended = events.find((e) => e.eventType === 'session:ended');

  const taskConfig = (started?.taskConfig ?? {}) as Record<string, unknown>;
  const startedAtUTC = started?.timestamp ?? events[0].timestamp ?? '';
  const startedAtMs = Date.parse(startedAtUTC) || 0;
  const taskCondition = String(taskConfig.taskCondition ?? started?.taskCondition ?? events[0].taskCondition ?? '');
  const robotCondition = String(started?.robotCondition ?? events[0].robotCondition ?? '');
  const rulePresetId = String(taskConfig.rulePresetId ?? '');
  const endReason = ended?.endReason != null ? String(ended.endReason) : '';
  const completed = endReason === 'timeout';

  // Task window: task:started → session:ended. The briefing before it does
  // not count. Without a session:ended (crash), fall back to the last event.
  const lastEventMs = events.reduce((max, e) => Math.max(max, Date.parse(e.timestamp) || 0), 0);
  const windowStartMs = taskStarted ? Date.parse(taskStarted.timestamp) || null : null;
  const windowEndMs = ended ? Date.parse(ended.timestamp) || lastEventMs : lastEventMs;

  let ticketsQueued = 0;
  let ticketsSorted = 0;
  let ticketsCorrect = 0;
  let ticketsIncorrect = 0;
  let robotSmalltalkCount = 0;
  let userUtteranceCount = 0;
  let userSpeakingMs = 0;

  const arrivalMsById = new Map<string, number>();
  const sorted: { id: string; sortedMs: number }[] = [];

  if (windowStartMs != null) {
    for (const e of events) {
      const ts = Date.parse(e.timestamp) || 0;
      if (ts < windowStartMs || ts > windowEndMs) continue;

      switch (e.eventType) {
        case 'ticket:queued':
          ticketsQueued++;
          if (typeof e.ticketId === 'string') arrivalMsById.set(e.ticketId, ts);
          break;
        case 'ticket:sorted':
          ticketsSorted++;
          if (e.correct === true) ticketsCorrect++;
          else ticketsIncorrect++;
          if (typeof e.ticketId === 'string') sorted.push({ id: e.ticketId, sortedMs: ts });
          break;
        case 'robot:speech:request':
          if (e.source === 'smalltalk' && e.disposition === 'fired') robotSmalltalkCount++;
          break;
        case 'user:utterance':
          userUtteranceCount++;
          if (typeof e.durationMs === 'number') userSpeakingMs += e.durationMs;
          break;
      }
    }
  }

  // Handling time per ticket: sort time minus the later of (its arrival, the
  // previous ticket's sort time) — so queue wait while the participant works
  // another ticket is not counted. Ticket ids are unique within a session
  // (repeats get a "#round" suffix), so each sort maps to one arrival.
  sorted.sort((a, b) => a.sortedMs - b.sortedMs);
  const handling: number[] = [];
  let prevSortedMs: number | null = null;
  for (const s of sorted) {
    const arrival = arrivalMsById.get(s.id);
    if (arrival != null) {
      const base = prevSortedMs == null ? arrival : Math.max(arrival, prevSortedMs);
      handling.push(s.sortedMs - base);
    }
    prevSortedMs = s.sortedMs;
  }

  return {
    participantId,
    sessionId,
    startedAtUTC,
    runIndex: null, // assigned once sessions are grouped per participant
    taskCondition,
    robotCondition,
    rulePresetId,
    completed,
    endReason,
    ticketsQueued,
    ticketsSorted,
    ticketsCorrect,
    ticketsIncorrect,
    score: ticketsCorrect - ticketsIncorrect,
    throughput: ticketsQueued > 0 ? ticketsSorted / ticketsQueued : null,
    accuracy: ticketsSorted > 0 ? ticketsCorrect / ticketsSorted : null,
    medianHandlingMs: median(handling),
    robotSmalltalkCount,
    userUtteranceCount,
    userSpeakingSec: userSpeakingMs / 1000,
    startedAtMs,
    hasTaskStarted: taskStarted != null,
    hasSessionEnded: ended != null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ------------------------------------------------------------------ //
//  Aggregation into participants + hinweise                           //
// ------------------------------------------------------------------ //

export function computeAnalysis(): Analysis {
  const sessionRows = readSessions().map(computeSessionRow);

  // Group by participant
  const byParticipant = new Map<string, SessionRow[]>();
  for (const row of sessionRows) {
    const list = byParticipant.get(row.participantId) ?? [];
    list.push(row);
    byParticipant.set(row.participantId, list);
  }

  // runIndex: rank among the participant's completed sessions by start time
  for (const rows of byParticipant.values()) {
    const completed = rows.filter((r) => r.completed).sort((a, b) => a.startedAtMs - b.startedAtMs);
    completed.forEach((r, i) => (r.runIndex = i + 1));
  }

  const participantRows: ParticipantRow[] = [];
  const hinweise: Hinweis[] = [];

  // Stable participant ordering for deterministic output
  const participantIds = [...byParticipant.keys()].sort();

  for (const pid of participantIds) {
    const rows = byParticipant.get(pid)!;

    // Per-session anomalies
    for (const r of rows) {
      if (!r.hasTaskStarted) {
        hinweise.push({ participantId: pid, sessionId: r.sessionId, grund: 'Keine task:started — die Aufgabe wurde in dieser Sitzung nie gestartet.' });
      }
      if (!r.hasSessionEnded) {
        hinweise.push({ participantId: pid, sessionId: r.sessionId, grund: 'Kein session:ended — Sitzung nicht regulär beendet (z.B. Absturz).' });
      }
    }

    const patternOk = PARTICIPANT_ID_PATTERN.test(pid);
    if (!patternOk) {
      hinweise.push({ participantId: pid, sessionId: '', grund: `participantId entspricht nicht dem Muster ${PARTICIPANT_ID_PATTERN.source}.` });
    }

    const talk = rows.filter((r) => r.completed && r.robotCondition === 'talkative');
    const quiet = rows.filter((r) => r.completed && r.robotCondition === 'quiet');

    if (talk.length === 1 && quiet.length === 1) {
      const t = talk[0];
      const q = quiet[0];
      if (t.taskCondition !== q.taskCondition) {
        hinweise.push({
          participantId: pid,
          sessionId: '',
          grund: `Unterschiedliche taskCondition in den beiden completed-Sessions (talkative: ${t.taskCondition || '—'}, quiet: ${q.taskCondition || '—'}) — nicht ins participants-Blatt übernommen.`,
        });
      } else if (patternOk) {
        participantRows.push(buildParticipantRow(pid, t, q));
      }
    } else {
      hinweise.push({
        participantId: pid,
        sessionId: '',
        grund: `Keine eindeutige Zuordnung: ${talk.length} completed talkative- und ${quiet.length} completed quiet-Session(en) (erwartet je genau 1).`,
      });
    }
  }

  return { sessionRows, participantRows, hinweise, participantIds };
}

function buildParticipantRow(pid: string, t: SessionRow, q: SessionRow): ParticipantRow {
  const diff = (a: number | null, b: number | null): number | null =>
    a != null && b != null ? a - b : null;

  return {
    participantId: pid,
    load: t.taskCondition,
    talkFirst: t.runIndex === 1 ? 1 : 0,
    rulePreset_talk: t.rulePresetId,
    rulePreset_quiet: q.rulePresetId,
    talk_score: t.score,
    quiet_score: q.score,
    talk_throughput: t.throughput,
    quiet_throughput: q.throughput,
    talk_accuracy: t.accuracy,
    quiet_accuracy: q.accuracy,
    talk_medianHandlingMs: t.medianHandlingMs,
    quiet_medianHandlingMs: q.medianHandlingMs,
    talk_robotSmalltalkCount: t.robotSmalltalkCount,
    quiet_robotSmalltalkCount: q.robotSmalltalkCount,
    talk_userUtteranceCount: t.userUtteranceCount,
    quiet_userUtteranceCount: q.userUtteranceCount,
    talk_userSpeakingSec: t.userSpeakingSec,
    quiet_userSpeakingSec: q.userSpeakingSec,
    adv_score: t.score - q.score,
    adv_throughput: diff(t.throughput, q.throughput),
    adv_accuracy: diff(t.accuracy, q.accuracy),
    // Reversed so a positive value everywhere means "the talkative agent helped"
    adv_medianHandlingMs: diff(q.medianHandlingMs, t.medianHandlingMs),
  };
}

// ------------------------------------------------------------------ //
//  Workbook building                                                   //
// ------------------------------------------------------------------ //

const SESSION_COLUMNS: { header: string; key: keyof SessionRow }[] = [
  { header: 'participantId', key: 'participantId' },
  { header: 'sessionId', key: 'sessionId' },
  { header: 'startedAtUTC', key: 'startedAtUTC' },
  { header: 'runIndex', key: 'runIndex' },
  { header: 'taskCondition', key: 'taskCondition' },
  { header: 'robotCondition', key: 'robotCondition' },
  { header: 'rulePresetId', key: 'rulePresetId' },
  { header: 'completed', key: 'completed' },
  { header: 'endReason', key: 'endReason' },
  { header: 'ticketsQueued', key: 'ticketsQueued' },
  { header: 'ticketsSorted', key: 'ticketsSorted' },
  { header: 'ticketsCorrect', key: 'ticketsCorrect' },
  { header: 'ticketsIncorrect', key: 'ticketsIncorrect' },
  { header: 'score', key: 'score' },
  { header: 'throughput', key: 'throughput' },
  { header: 'accuracy', key: 'accuracy' },
  { header: 'medianHandlingMs', key: 'medianHandlingMs' },
  { header: 'robotSmalltalkCount', key: 'robotSmalltalkCount' },
  { header: 'userUtteranceCount', key: 'userUtteranceCount' },
  { header: 'userSpeakingSec', key: 'userSpeakingSec' },
];

const PARTICIPANT_COLUMNS: { header: string; key: keyof ParticipantRow }[] = [
  { header: 'participantId', key: 'participantId' },
  { header: 'load', key: 'load' },
  { header: 'talkFirst', key: 'talkFirst' },
  { header: 'rulePreset_talk', key: 'rulePreset_talk' },
  { header: 'rulePreset_quiet', key: 'rulePreset_quiet' },
  { header: 'talk_score', key: 'talk_score' },
  { header: 'quiet_score', key: 'quiet_score' },
  { header: 'talk_throughput', key: 'talk_throughput' },
  { header: 'quiet_throughput', key: 'quiet_throughput' },
  { header: 'talk_accuracy', key: 'talk_accuracy' },
  { header: 'quiet_accuracy', key: 'quiet_accuracy' },
  { header: 'talk_medianHandlingMs', key: 'talk_medianHandlingMs' },
  { header: 'quiet_medianHandlingMs', key: 'quiet_medianHandlingMs' },
  { header: 'talk_robotSmalltalkCount', key: 'talk_robotSmalltalkCount' },
  { header: 'quiet_robotSmalltalkCount', key: 'quiet_robotSmalltalkCount' },
  { header: 'talk_userUtteranceCount', key: 'talk_userUtteranceCount' },
  { header: 'quiet_userUtteranceCount', key: 'quiet_userUtteranceCount' },
  { header: 'talk_userSpeakingSec', key: 'talk_userSpeakingSec' },
  { header: 'quiet_userSpeakingSec', key: 'quiet_userSpeakingSec' },
  { header: 'adv_score', key: 'adv_score' },
  { header: 'adv_throughput', key: 'adv_throughput' },
  { header: 'adv_accuracy', key: 'adv_accuracy' },
  { header: 'adv_medianHandlingMs', key: 'adv_medianHandlingMs' },
];

const HINWEIS_COLUMNS: { header: string; key: keyof Hinweis }[] = [
  { header: 'participantId', key: 'participantId' },
  { header: 'sessionId', key: 'sessionId' },
  { header: 'grund', key: 'grund' },
];

/** Build a workbook. When participantId is given, only that participant's
 *  rows are included (the participants sheet is then 0 or 1 row). */
function buildWorkbook(analysis: Analysis, participantId?: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'thesis-backend';
  wb.created = new Date();

  const keep = <T extends { participantId: string }>(rows: T[]): T[] =>
    participantId ? rows.filter((r) => r.participantId === participantId) : rows;

  addSheet(wb, 'sessions', SESSION_COLUMNS, keep(analysis.sessionRows));
  addSheet(wb, 'participants', PARTICIPANT_COLUMNS, keep(analysis.participantRows));
  addSheet(wb, 'hinweise', HINWEIS_COLUMNS, keep(analysis.hinweise));

  return wb;
}

function addSheet<T>(
  wb: ExcelJS.Workbook,
  name: string,
  columns: { header: string; key: keyof T }[],
  rows: T[],
): void {
  const sheet = wb.addWorksheet(name);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.header, width: Math.max(12, c.header.length + 2) }));
  for (const row of rows) {
    const record: Record<string, unknown> = {};
    for (const c of columns) {
      const value = row[c.key];
      // null/undefined → empty cell; everything else kept as its real type
      // (numbers stay numbers, booleans stay booleans) and never rounded.
      record[c.header] = value ?? null;
    }
    sheet.addRow(record);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

// ------------------------------------------------------------------ //
//  Writing                                                             //
// ------------------------------------------------------------------ //

function ensureDirs(): void {
  if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });
  if (!existsSync(PARTICIPANTS_DIR)) mkdirSync(PARTICIPANTS_DIR, { recursive: true });
}

function sanitizeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function participantExportPath(participantId: string): string {
  return join(PARTICIPANTS_DIR, `${sanitizeFileName(participantId)}.xlsx`);
}

/** Recompute and overwrite the aggregate file and this participant's file. */
export async function regenerateExportsForParticipant(participantId: string): Promise<void> {
  ensureDirs();
  const analysis = computeAnalysis();
  await buildWorkbook(analysis).xlsx.writeFile(ALL_EXPORT_FILE);
  await buildWorkbook(analysis, participantId).xlsx.writeFile(participantExportPath(participantId));
}

/** Recompute and overwrite the aggregate file and every participant file. */
export async function regenerateAllExports(): Promise<{ participantIds: string[] }> {
  ensureDirs();
  const analysis = computeAnalysis();
  await buildWorkbook(analysis).xlsx.writeFile(ALL_EXPORT_FILE);
  for (const pid of analysis.participantIds) {
    await buildWorkbook(analysis, pid).xlsx.writeFile(participantExportPath(pid));
  }
  return { participantIds: analysis.participantIds };
}
