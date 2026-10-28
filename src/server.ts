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
import { getJsonlExportPath, listLoggedSessions } from './logger';
import {
  ALL_EXPORT_FILE,
  participantExportPath,
  regenerateAllExports,
  regenerateExportsForParticipant,
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

// Download the aggregate analysis (all sessions / participants). Recomputed
// from the JSONL logs on each request so the download is always current, even
// after a restart or a manual change to the logs.
app.get('/export/all', async (_req, res) => {
  try {
    await regenerateAllExports();
    res.download(ALL_EXPORT_FILE, 'all.xlsx');
  } catch (err) {
    console.error('[Server] Export (all) failed:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// Download one participant's analysis file (recomputed on request, see above)
app.get('/export/participant/:participantId', async (req, res) => {
  const { participantId } = req.params;
  try {
    if (!computeAnalysis().participantIds.includes(participantId)) {
      return void res.status(404).json({ error: 'No data for this participant.' });
    }
    await regenerateExportsForParticipant(participantId);
    res.download(participantExportPath(participantId), `${participantId}.xlsx`);
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
