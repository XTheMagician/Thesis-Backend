import { createWriteStream, existsSync, mkdirSync, WriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ActiveRules } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '../logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// Fixed column order — unused fields are left empty per event type
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
] as const;

type Column = (typeof COLUMNS)[number];
type EventFields = Partial<Record<Column, string | number | boolean | ActiveRules | null>>;

function escape(val: unknown): string {
  if (val === undefined || val === null) return '';
  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

interface StreamEntry {
  stream: WriteStream;
  filePath: string;
}

const openStreams = new Map<string, StreamEntry>();

function getStream(sessionId: string): StreamEntry {
  const existing = openStreams.get(sessionId);
  if (existing) return existing;

  const filePath = join(LOGS_DIR, `${sessionId}.csv`);
  const stream = createWriteStream(filePath, { flags: 'a' });
  stream.write(COLUMNS.join(',') + '\n');

  const entry: StreamEntry = { stream, filePath };
  openStreams.set(sessionId, entry);
  return entry;
}

export function logEvent(
  sessionId: string,
  participantId: string,
  condition: string,
  eventType: string,
  fields: EventFields = {},
): void {
  const { stream } = getStream(sessionId);
  const row: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    sessionId,
    participantId,
    condition,
    eventType,
    ...fields,
  };
  stream.write(COLUMNS.map((col) => escape(row[col])).join(',') + '\n');
}

export function closeSession(sessionId: string): void {
  const entry = openStreams.get(sessionId);
  if (!entry) return;
  entry.stream.end();
  openStreams.delete(sessionId);
}

export function getExportPath(sessionId: string): string | null {
  const filePath = join(LOGS_DIR, `${sessionId}.csv`);
  return existsSync(filePath) ? filePath : null;
}
