import { createWriteStream, existsSync, mkdirSync, readdirSync, WriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOGS_DIR = join(__dirname, '../logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ------------------------------------------------------------------ //
//  JSONL event log — the single raw-data source                       //
//                                                                      //
//  One <sessionId>.jsonl file per session, one JSON object per line,   //
//  carrying every field of every event. All analysis files (the xlsx  //
//  exports) are computed from these logs and never written alongside   //
//  them — see export.ts. Timestamps are ISO-8601 UTC from this one     //
//  backend clock.                                                       //
// ------------------------------------------------------------------ //

export interface LogMeta {
  sessionId: string;
  participantId: string;
  taskCondition: string;
  robotCondition: string;
}

const openStreams = new Map<string, WriteStream>();

function getStream(sessionId: string): WriteStream {
  const existing = openStreams.get(sessionId);
  if (existing) return existing;
  const jsonl = createWriteStream(join(LOGS_DIR, `${sessionId}.jsonl`), { flags: 'a' });
  openStreams.set(sessionId, jsonl);
  return jsonl;
}

/** Append one event to the session's JSONL log. */
export function logEvent(
  meta: LogMeta,
  eventType: string,
  fields: Record<string, unknown> = {},
): void {
  const jsonl = getStream(meta.sessionId);
  const timestamp = new Date().toISOString();
  jsonl.write(JSON.stringify({ timestamp, ...meta, eventType, ...fields }) + '\n');
}

/**
 * Robot events (state transitions, transcripts, speech requests). Identical
 * to logEvent now that there is a single log; kept as a separate entry point
 * so the orchestrator's robot-logging wiring reads clearly.
 */
export function logRobotEvent(
  meta: LogMeta,
  eventType: string,
  fields: Record<string, unknown> = {},
): void {
  logEvent(meta, eventType, fields);
}

/** Flush and close a session's JSONL stream; resolves once it is on disk. */
export function closeSession(sessionId: string): Promise<void> {
  const stream = openStreams.get(sessionId);
  if (!stream) return Promise.resolve();
  openStreams.delete(sessionId);
  return new Promise((resolve) => stream.end(() => resolve()));
}

/** All logged session IDs, newest first (IDs end in their start timestamp). */
export function listLoggedSessions(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(LOGS_DIR)) {
    if (file.endsWith('.jsonl')) ids.add(file.replace(/\.jsonl$/, ''));
  }
  const startedAt = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;
  return [...ids].sort((a, b) => startedAt(b) - startedAt(a));
}

export function getJsonlExportPath(sessionId: string): string | null {
  const filePath = join(LOGS_DIR, `${sessionId}.jsonl`);
  return existsSync(filePath) ? filePath : null;
}
