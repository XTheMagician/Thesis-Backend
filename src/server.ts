import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import express from 'express';
import dotenv from 'dotenv';
import { Hub } from './hub';
import { Orchestrator } from './orchestrator';
import { DialogManager } from './robot/dialog-manager';
import { SpeechScheduler } from './robot/scheduler';
import { handleMessage } from './ws-router';
import { getExportPath, getJsonlExportPath, getAllExportCsv, listLoggedSessions } from './logger';

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

// List all logged sessions (newest first) — the admin panel's export block.
// CORS header because the panel fetches this from the Vite dev origin.
app.get('/sessions', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ sessions: listLoggedSessions() });
});

// Download a session's CSV log
app.get('/export/:sessionId', (req, res) => {
  const filePath = getExportPath(req.params.sessionId);
  if (!filePath) return void res.status(404).json({ error: 'Session log not found.' });
  res.download(filePath);
});

// Download all sessions as a single combined CSV
app.get('/export-all', (_req, res) => {
  const csv = getAllExportCsv();
  if (!csv) return void res.status(404).json({ error: 'No session logs found.' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="all-sessions.csv"');
  res.send(csv);
});

// Download a session's full JSONL event log
app.get('/export-jsonl/:sessionId', (req, res) => {
  const filePath = getJsonlExportPath(req.params.sessionId);
  if (!filePath) return void res.status(404).json({ error: 'Session log not found.' });
  res.download(filePath);
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

// Robot subsystems, driven by the study-session lifecycle
orchestrator.register({
  name: 'voice',
  onSessionStart: (session) => dialog.startVoice(session.robotConfig),
  onSessionEnd: () => dialog.stopVoice(),
});
orchestrator.register(new SpeechScheduler(dialog));

// ------------------------------------------------------------------ //
//  Start                                                               //
// ------------------------------------------------------------------ //
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT} (all interfaces)`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] Export CSV: http://localhost:${PORT}/export/<sessionId>`);
  console.log(`[Server] Export all CSV: http://localhost:${PORT}/export-all`);
  console.log(`[Server] Export JSONL: http://localhost:${PORT}/export-jsonl/<sessionId>`);
});
