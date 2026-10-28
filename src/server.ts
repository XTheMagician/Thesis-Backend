import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import express from 'express';
import dotenv from 'dotenv';
import { Hub } from './hub';
import { Orchestrator } from './orchestrator';
import { DialogManager } from './robot/dialog-manager';
import { SpeechScheduler } from './robot/scheduler';
import { handleMessage } from './ws-router';
import { BRIEFING_TOOLS } from './config/conditions';
import { existsSync } from 'fs';
import { getJsonlExportPath, listLoggedSessions } from './logger';
import {
  ALL_EXPORT_FILE,
  participantExportPath,
  regenerateAllExports,
  computeAnalysis,
} from './export';

dotenv.config();

const PORT = parseInt(process.env.PORT ?? '3000');

// ------------------------------------------------------------------ //
//  HTTP server                                                         //
// ------------------------------------------------------------------ //
const app = express();
app.use(express.json());

// Health check — useful for confirming the server is reachable on local Wi-Fi
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clients: hub.clientCount,
    session: orchestrator.session?.id ?? null,
  });
});

// The admin panel fetches these from the Vite dev origin — allow CORS.
const allowCors = (res: express.Response) => res.setHeader('Access-Control-Allow-Origin', '*');

// List all logged sessions (newest first) — the admin panel's export block.
app.get('/sessions', (_req, res) => {
  allowCors(res);
  res.json({ sessions: listLoggedSessions() });
});

// Download a session's raw JSONL event log (the single source of truth)
app.get('/export-jsonl/:sessionId', (req, res) => {
  const filePath = getJsonlExportPath(req.params.sessionId);
  if (!filePath) return void res.status(404).json({ error: 'Session log not found.' });
  res.download(filePath);
});

// List the participants that appear in the logs — for the export UI
app.get('/export/participants', (_req, res) => {
  allowCors(res);
  res.json({ participants: computeAnalysis().participantIds });
});

// Recompute every analysis file from the JSONL logs ("Auswertung exportieren")
app.options('/export/rebuild', (_req, res) => {
  allowCors(res);
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.sendStatus(204);
});

app.post('/export/rebuild', async (_req, res) => {
  allowCors(res);
  try {
    const { participantIds } = await regenerateAllExports();
    res.json({ ok: true, participants: participantIds });
  } catch (err) {
    console.error('[Server] Export rebuild failed:', err);
    res.status(500).json({ error: 'Export rebuild failed.' });
  }
});

// Download the aggregate analysis (all sessions / participants)
app.get('/export/all', async (_req, res) => {
  try {
    if (!existsSync(ALL_EXPORT_FILE)) await regenerateAllExports();
    res.download(ALL_EXPORT_FILE, 'all.xlsx');
  } catch (err) {
    console.error('[Server] Export (all) failed:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// Download one participant's analysis file
app.get('/export/participant/:participantId', async (req, res) => {
  const { participantId } = req.params;
  try {
    const filePath = participantExportPath(participantId);
    if (!existsSync(filePath)) await regenerateAllExports();
    if (!existsSync(filePath)) {
      return void res.status(404).json({ error: 'No data for this participant.' });
    }
    res.download(filePath, `${participantId}.xlsx`);
  } catch (err) {
    console.error('[Server] Export (participant) failed:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

const httpServer = createServer(app);

// ------------------------------------------------------------------ //
//  WebSocket hub + orchestrator wiring                                 //
// ------------------------------------------------------------------ //
const wss = new WebSocketServer({ server: httpServer });
const hub = new Hub(wss);
const dialog = new DialogManager(hub);
const orchestrator = new Orchestrator(hub, dialog);

hub.onMessage((clientId, msg) => handleMessage({ clientId, msg, hub, orchestrator, dialog }));
hub.onUnityBinary((_clientId, pcm) => dialog.handleMicAudio(pcm));

// Robot subsystems, driven by the study-session lifecycle. Demo runs
// showcase the app only — no voice session, so the robot stays silent.
orchestrator.register({
  name: 'voice',
  onSessionStart: (session) => {
    if (!session.demo) dialog.startVoice(session.robotConfig, BRIEFING_TOOLS);
  },
  onSessionEnd: () => dialog.stopVoice(),
});
orchestrator.register(new SpeechScheduler(dialog));

// ------------------------------------------------------------------ //
//  Start                                                               //
// ------------------------------------------------------------------ //
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT} (all interfaces)`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] Raw log (JSONL): http://localhost:${PORT}/export-jsonl/<sessionId>`);
  console.log(`[Server] Analysis (all):  http://localhost:${PORT}/export/all`);
  console.log(`[Server] Analysis (one):  http://localhost:${PORT}/export/participant/<participantId>`);
});

// Give an active session a session:ended (endReason "error") on shutdown, so a
// Ctrl-C mid-run still produces a closed JSONL log rather than a dangling one.
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    orchestrator.endSession('error');
  } catch (err) {
    console.error('[Server] Error ending session on shutdown:', err);
  }
  // Allow the JSONL flush / export kicked off by endSession to run briefly
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
