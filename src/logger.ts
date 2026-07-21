import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, WriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '../logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ------------------------------------------------------------------ //
//  Every event is written twice:                                       //
//  - <sessionId>.csv   — fixed columns, for the task-metric analysis   //
//  - <sessionId>.jsonl — one JSON object per line, carries all fields  //
//    (transcripts, configs, …) and doubles as crash-recovery data      //
// ------------------------------------------------------------------ //

// Fixed column order — unused fields are left empty per event type.
// robotCondition is appended last so older CSVs stay column-compatible.
const COLUMNS = [
  'timestamp',
  'sessionId',
  'participantId',
  'condition',
  'eventType',
  'ticketId',
  'ticketCategory',
  'decision',
  'correct',
  'activeRules',
  'robotSpeech',
  'timeInQueueMs',
  'totalProcessed',
  'totalCorrect',
  'totalWrong',
  'accuracy',
  'sessionDurationMs',
  'robotCondition',
] as const;

export interface LogMeta {
  sessionId: string;
  participantId: string;
  taskCondition: string;
  robotCondition: string;
}

function escape(val: unknown): string {
  if (val === undefined || val === null) return '';
  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

interface StreamEntry {
  csv: WriteStream;
  jsonl: WriteStream;
}

const openStreams = new Map<string, StreamEntry>();

function getStreams(sessionId: string): StreamEntry {
  const existing = openStreams.get(sessionId);
  if (existing) return existing;

  const csv = createWriteStream(join(LOGS_DIR, `${sessionId}.csv`), { flags: 'a' });
  csv.write(COLUMNS.join(',') + '\n');
  const jsonl = createWriteStream(join(LOGS_DIR, `${sessionId}.jsonl`), { flags: 'a' });

  const entry: StreamEntry = { csv, jsonl };
  openStreams.set(sessionId, entry);
  return entry;
}

export function logEvent(
  meta: LogMeta,
  eventType: string,
  fields: Record<string, unknown> = {},
): void {
  const { csv, jsonl } = getStreams(meta.sessionId);
  const timestamp = new Date().toISOString();

  // JSONL carries everything, including fields the CSV has no column for
  jsonl.write(JSON.stringify({ timestamp, ...meta, eventType, ...fields }) + '\n');

  const row: Record<string, unknown> = {
    timestamp,
    sessionId: meta.sessionId,
    participantId: meta.participantId,
    condition: meta.taskCondition,
    robotCondition: meta.robotCondition,
    eventType,
    ...fields,
  };
  csv.write(COLUMNS.map((col) => escape(row[col])).join(',') + '\n');
}

/**
 * JSONL-only variant for robot events (state transitions, transcripts,
 * speech requests) — they have no CSV columns and would only produce
 * near-empty rows in the fixed-column task log.
 */
export function logRobotEvent(
  meta: LogMeta,
  eventType: string,
  fields: Record<string, unknown> = {},
): void {
  const { jsonl } = getStreams(meta.sessionId);
  jsonl.write(JSON.stringify({ timestamp: new Date().toISOString(), ...meta, eventType, ...fields }) + '\n');
}

export function closeSession(sessionId: string): void {
  const entry = openStreams.get(sessionId);
  if (!entry) return;
  entry.csv.end();
  entry.jsonl.end();
  openStreams.delete(sessionId);
}

/** All logged session IDs, newest first (IDs end in their start timestamp). */
export function listLoggedSessions(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(LOGS_DIR)) {
    if (file === SUMMARY_FILENAME) continue;
    if (file.endsWith('.csv') || file.endsWith('.jsonl')) {
      ids.add(file.replace(/\.(csv|jsonl)$/, ''));
    }
  }
  const startedAt = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;
  return [...ids].sort((a, b) => startedAt(b) - startedAt(a));
}

export function getExportPath(sessionId: string): string | null {
  const filePath = join(LOGS_DIR, `${sessionId}.csv`);
  return existsSync(filePath) ? filePath : null;
}

export function getJsonlExportPath(sessionId: string): string | null {
  const filePath = join(LOGS_DIR, `${sessionId}.jsonl`);
  return existsSync(filePath) ? filePath : null;
}

export function getAllExportCsv(): string | null {
  const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith('.csv') && f !== SUMMARY_FILENAME).sort();
  if (files.length === 0) return null;

  let combined = '';
  let headerWritten = false;

  for (const file of files) {
    const content = readFileSync(join(LOGS_DIR, file), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    if (!headerWritten) {
      combined += lines[0] + '\n';
      headerWritten = true;
    }
    combined += lines.slice(1).join('\n') + '\n';
  }

  return combined || null;
}

// ------------------------------------------------------------------ //
//  Shortform summary — one shared file, one line per session           //
//                                                                        //
//  Separate from the per-session CSV/JSONL above: those carry every     //
//  event for detailed analysis, this is the single file to hand to      //
//  stats software directly. Written once, at session end.               //
// ------------------------------------------------------------------ //

const SUMMARY_FILENAME = 'summary.csv';
const SUMMARY_FILE = join(LOGS_DIR, SUMMARY_FILENAME);

// Header spelled out exactly as used for the stats pipeline.
const SUMMARY_COLUMNS = [
  'ParticipantID',
  'timestamp',
  'sessionID',
  'conditionTask',
  'conditionRobot',
  'totalCorrect',
  'totalWrong',
  'Performance',
] as const;

export function logSessionSummary(
  meta: LogMeta,
  totals: { totalCorrect: number; totalWrong: number },
): void {
  const isNewFile = !existsSync(SUMMARY_FILE);
  const row = [
    meta.participantId,
    new Date().toISOString(),
    meta.sessionId,
    meta.taskCondition,
    meta.robotCondition,
    totals.totalCorrect,
    totals.totalWrong,
    totals.totalCorrect - totals.totalWrong,
  ];
  const line = row.map(escape).join(',') + '\n';
  writeFileSync(SUMMARY_FILE, (isNewFile ? SUMMARY_COLUMNS.join(',') + '\n' : '') + line, { flag: 'a' });
}

export function getSummaryExportPath(): string | null {
  return existsSync(SUMMARY_FILE) ? SUMMARY_FILE : null;
}

/**
 * Removes a session's row from the summary file — for discarding a botched
 * trial (wrong condition picked, participant restarted mid-task, …) without
 * hand-editing the CSV. The per-session CSV/JSONL logs are left untouched,
 * so the raw record is still there if the mistake needs to be traced later.
 * Returns false if the sessionId had no row (nothing to remove).
 */
export function deleteSessionSummary(sessionId: string): boolean {
  if (!existsSync(SUMMARY_FILE)) return false;
  const lines = readFileSync(SUMMARY_FILE, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;

  const [header, ...rows] = lines;
  const kept = rows.filter((row) => splitCsvLine(row)[2] !== sessionId);
  if (kept.length === rows.length) return false;

  writeFileSync(SUMMARY_FILE, [header, ...kept].join('\n') + '\n');
  return true;
}

// Splits a CSV row on commas outside quotes — sufficient for the plain
// values summary.csv holds (no embedded newlines to worry about).
function splitCsvLine(line: string): string[] {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => {
    const trimmed = cell.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).replace(/""/g, '"')
      : trimmed;
  });
}
