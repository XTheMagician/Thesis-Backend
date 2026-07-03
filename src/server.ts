import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import express from 'express';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { handleMessage } from './ws-router';
import { getExportPath, getAllExportCsv } from './logger';
import type { InboundMessage, WsClient } from './types';
import type { Session } from './session';

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
    clients: clients.size,
    session: activeSession?.id ?? null,
  });
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

const httpServer = createServer(app);

// ------------------------------------------------------------------ //
//  WebSocket server (shares the HTTP port)                            //
// ------------------------------------------------------------------ //
const wss = new WebSocketServer({ server: httpServer });

const clients = new Map<string, WsClient>();
let activeSession: Session | null = null;

function broadcast(event: object): void {
  const msg = JSON.stringify(event);
  for (const { ws } of clients.values()) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  const clientId = randomUUID();
  clients.set(clientId, { ws, type: 'unknown' });
  console.log(`[WS] + ${clientId}`);

  ws.send(JSON.stringify({ type: 'server:hello', clientId }));

  ws.on('message', (raw) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON.' }));
      return;
    }

    // Identification handshake — handled here before routing
    if (msg.type === 'client:identify') {
      const client = clients.get(clientId)!;
      const t = msg['clientType'];
      client.type = (t === 'browser' || t === 'unity') ? t : 'unknown';
      console.log(`[WS] ${clientId} → ${client.type}`);
      ws.send(JSON.stringify({ type: 'client:identified', clientId, clientType: client.type }));
      return;
    }

    handleMessage({
      clientId,
      msg: msg as InboundMessage,
      clients,
      broadcast,
      getSession: () => activeSession,
      setSession: (s) => { activeSession = s; },
    });
  });

  ws.on('close', () => {
    console.log(`[WS] - ${clientId}`);
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error on ${clientId}: ${err.message}`);
  });
});

// ------------------------------------------------------------------ //
//  Start                                                               //
// ------------------------------------------------------------------ //
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT} (all interfaces)`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] Export: http://localhost:${PORT}/export/<sessionId>`);
  console.log(`[Server] Export all: http://localhost:${PORT}/export-all`);
});
