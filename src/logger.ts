import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, WriteStream } from 'fs';
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
  const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith('.csv')).sort();
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
