import { writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import ExcelJS from 'exceljs';
import { LOGS_DIR } from '../src/logger';
import { regenerateAllExports, computeAnalysis, ALL_EXPORT_FILE, participantExportPath } from '../src/export';

// Build one session's JSONL from a compact event list. `base` is the
// session-start epoch ms; each event's `at` is seconds from session start.
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface Ev { at: number; eventType: string; [k: string]: unknown }

function writeSession(
  sessionId: string,
  participantId: string,
  taskCondition: string,
  robotCondition: string,
  base: number,
  events: Ev[],
): void {
  const lines = events.map((e) => {
    const { at, eventType, ...rest } = e;
    return JSON.stringify({
      timestamp: iso(base + at * 1000),
      sessionId,
      participantId,
      taskCondition,
      robotCondition,
      eventType,
      ...rest,
    });
  });
  writeFileSync(join(LOGS_DIR, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

const TEST_IDS = new Set<string>();

function session(
  participantId: string,
  taskCondition: string,
  robotCondition: string,
  rulePresetId: string,
  base: number,
  opts: { ended?: 'timeout' | 'aborted' | null; taskStarted?: boolean } = {},
  events: Ev[] = [],
): string {
  const sessionId = `${participantId}-${taskCondition}-${robotCondition}-${base}`;
  TEST_IDS.add(sessionId);
  const full: Ev[] = [
    {
      at: 0,
      eventType: 'session:started',
      schemaVersion: 1,
      appVersion: 'test',
      taskConfig: { taskCondition, ticketIntervalMs: 5000, ticketJitter: 0.3, durationMs: 60000, rulePresetId, categoryCount: 4 },
    },
    ...(opts.taskStarted === false ? [] : [{ at: 10, eventType: 'task:started', trigger: 'admin' }]),
    ...events,
    ...(opts.ended === null
      ? []
      : [{ at: 70, eventType: 'session:ended', endReason: opts.ended ?? 'timeout' }]),
  ];
  writeSession(sessionId, participantId, taskCondition, robotCondition, base, full);
  return sessionId;
}

// Task-window events are at seconds relative to session start; task starts at
// +10s, so use +11s and later. (Arrival/sort times below are chosen so the
// expected handling times are easy to check by hand.)
const talkEvents: Ev[] = [
  { at: 11, eventType: 'ticket:queued', ticketId: 'T1', ticketCategory: 'software' },
  { at: 13, eventType: 'ticket:queued', ticketId: 'T2', ticketCategory: 'hr' },
  { at: 15, eventType: 'ticket:sorted', ticketId: 'T1', correct: true, timeInQueueMs: 4000 },
  { at: 19, eventType: 'ticket:sorted', ticketId: 'T2', correct: false, timeInQueueMs: 6000 },
  { at: 14, eventType: 'robot:speech:request', source: 'smalltalk', disposition: 'fired' },
  { at: 20, eventType: 'robot:speech:request', source: 'smalltalk', disposition: 'queued' }, // not counted
  { at: 16, eventType: 'user:utterance', startedAt: iso(0), endedAt: iso(2000), durationMs: 2000 },
];
// Expected talk: queued 2, sorted 2, correct 1, incorrect 1, score 0,
// throughput 1, accuracy 0.5, smalltalk 1, utter 1, speakingSec 2
// handling: T1 15-11=4000; T2 max(13,15)=15 -> 19-15=4000; median 4000

const quietEvents: Ev[] = [
  { at: 11, eventType: 'ticket:queued', ticketId: 'T1', ticketCategory: 'software' },
  { at: 12, eventType: 'ticket:queued', ticketId: 'T2', ticketCategory: 'hr' },
  { at: 13, eventType: 'ticket:queued', ticketId: 'T3', ticketCategory: 'shipping' },
  { at: 20, eventType: 'ticket:sorted', ticketId: 'T1', correct: true, timeInQueueMs: 9000 },
  { at: 22, eventType: 'ticket:sorted', ticketId: 'T2', correct: true, timeInQueueMs: 10000 },
  // no smalltalk in quiet
];
// Expected quiet: queued 3, sorted 2, correct 2, incorrect 0, score 2,
// throughput 2/3, accuracy 1, smalltalk 0, utter 0, speakingSec 0
// handling: T1 20-11=9000; T2 max(12,20)=20 -> 22-20=2000; median (9000+2000)/2=5500

const base = Date.UTC(2026, 0, 1, 12, 0, 0);

// P900 — qualifies: 1 completed talkative + 1 completed quiet, same load (easy)
session('P900', 'easy', 'talkative', 'none', base, { ended: 'timeout' }, talkEvents);
session('P900', 'easy', 'quiet', 'none', base + 600_000, { ended: 'timeout' }, quietEvents);

// P901 — only one completed session (quiet aborted) -> hinweis, no participant row
session('P901', 'hard', 'talkative', 'Plan A', base, { ended: 'timeout' }, talkEvents);
session('P901', 'hard', 'quiet', 'Plan A', base + 600_000, { ended: 'aborted' }, quietEvents);

// P902 — crash: no session:ended, no task:started
session('P902', 'easy', 'quiet', 'none', base, { ended: null, taskStarted: false }, []);

// badId — participantId does not match pattern
session('badId', 'easy', 'talkative', 'none', base, { ended: 'timeout' }, talkEvents);

async function main() {
  await regenerateAllExports();
  const analysis = computeAnalysis();

  console.log('\n=== SESSION ROWS ===');
  for (const r of analysis.sessionRows) {
    console.log(
      `${r.participantId} ${r.robotCondition} completed=${r.completed} run=${r.runIndex} ` +
      `Q=${r.ticketsQueued} S=${r.ticketsSorted} C=${r.ticketsCorrect} W=${r.ticketsIncorrect} ` +
      `score=${r.score} thr=${r.throughput} acc=${r.accuracy} med=${r.medianHandlingMs} ` +
      `smalltalk=${r.robotSmalltalkCount} utt=${r.userUtteranceCount} spk=${r.userSpeakingSec} endReason=${r.endReason || '-'}`,
    );
  }

  console.log('\n=== PARTICIPANT ROWS ===');
  for (const p of analysis.participantRows) {
    console.log(JSON.stringify(p));
  }

  console.log('\n=== HINWEISE ===');
  for (const h of analysis.hinweise) {
    console.log(`${h.participantId} | ${h.sessionId || '-'} | ${h.grund}`);
  }

  // Read all.xlsx back and confirm cell types are real numbers
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ALL_EXPORT_FILE);
  const sessionsSheet = wb.getWorksheet('sessions')!;
  console.log('\n=== all.xlsx sheets ===', wb.worksheets.map((w) => w.name).join(', '));
  const headerRow = sessionsSheet.getRow(1).values;
  console.log('sessions header:', JSON.stringify(headerRow));
  // Check a throughput cell is a number
  const accCol = (headerRow as unknown[]).indexOf('accuracy');
  const r2 = sessionsSheet.getRow(2);
  console.log('row2 accuracy cell type:', typeof r2.getCell(accCol).value, '=', r2.getCell(accCol).value);

  console.log('\nparticipant file P900 exists:', existsSync(participantExportPath('P900')));
  console.log('participant file P902 exists:', existsSync(participantExportPath('P902')));

  // Verify participant-file "participants" sheet for P901 is empty (0 data rows)
  const p901 = new ExcelJS.Workbook();
  await p901.xlsx.readFile(participantExportPath('P901'));
  console.log('P901 participants rowCount (incl header):', p901.getWorksheet('participants')!.rowCount);
  console.log('P901 hinweise rowCount (incl header):', p901.getWorksheet('hinweise')!.rowCount);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    // Clean up synthetic logs + participant files we created
    for (const id of TEST_IDS) {
      const f = join(LOGS_DIR, `${id}.jsonl`);
      if (existsSync(f)) rmSync(f);
    }
    for (const pid of ['P900', 'P901', 'P902', 'badId']) {
      const f = participantExportPath(pid);
      if (existsSync(f)) rmSync(f);
    }
    console.log('\n(cleaned up synthetic logs; remaining jsonl files:', readdirSync(LOGS_DIR).filter((f) => f.endsWith('.jsonl')).length, ')');
  });
