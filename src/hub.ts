import { randomUUID } from 'crypto';
import type { WebSocketServer } from 'ws';
import type { ClientType, InboundMessage, WsClient } from './types';

const OPEN = 1; // WebSocket.OPEN
// Without a heartbeat, a headset that leaves Wi-Fi without closing its
// socket would count as connected for minutes (until TCP gives up). Kept
// lenient on purpose: dropping the Unity client cuts the robot's voice, so
// a client only goes after three missed rounds (~30 s), never for one late pong.
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_MAX_MISSED = 3;
// App-level counterpart for the Unity app: ping frames are invisible to its
// code, so it gets a small JSON message and reconnects if these stop (its
// watchdog, ~15 s) — e.g. after visionOS froze the app despite background audio.
const UNITY_HEARTBEAT_MS = 5_000;

export type ClientChange = {
  clientId: string;
  clientType: ClientType;
  change: 'identified' | 'disconnected' | 'lifecycle';
  /** disconnected: close code, 'heartbeat' (server dropped an unresponsive
   *  client) or 'app-paused' (the app went away while in the background);
   *  lifecycle: the reported event (paused, resumed, focus-lost, focus-gained) */
  reason?: string;
};

type MessageHandler = (clientId: string, msg: InboundMessage) => void;
type BinaryHandler = (clientId: string, data: Buffer) => void;

/**
 * Client registry and transport layer.
 *
 * Owns all connected sockets, the identify handshake, and the split
 * between JSON control messages and binary frames. Binary frames from
 * the Unity client (mic PCM audio) are passed to the registered binary
 * handler — the voice-provider session will register itself here.
 *
 * Every change in who is connected is broadcast as `clients:status` so
 * the admin panel can show whether the Unity app is there.
 */
export class Hub {
  private clients = new Map<string, WsClient>();
  private messageHandler: MessageHandler | null = null;
  private unityBinaryHandler: BinaryHandler | null = null;
  // Clients the heartbeat dropped / that announced a pause, so their close
  // is attributed correctly
  private droppedByHeartbeat = new Set<string>();
  // Clients currently in the background (reported 'paused', not yet 'resumed')
  private inBackground = new Set<string>();
  // Why the Unity app went away last; cleared when it is back
  private unityDisconnectReason: string | null = null;

  /** Connection changes of identified clients — the orchestrator logs them */
  onClientChange?: (change: ClientChange) => void;

  constructor(wss: WebSocketServer) {
    const heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_MS);
    const unityHeartbeat = setInterval(() => this.sendTo('unity', { type: 'server:heartbeat' }), UNITY_HEARTBEAT_MS);
    wss.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(unityHeartbeat);
    });

    wss.on('connection', (ws) => {
      const clientId = randomUUID();
      this.clients.set(clientId, { ws, type: 'unknown', missedPings: 0 });
      console.log(`[WS] + ${clientId}`);

      ws.on('pong', () => {
        const client = this.clients.get(clientId);
        if (client) client.missedPings = 0;
      });

      ws.send(JSON.stringify({ type: 'server:hello', clientId }));

      ws.on('message', (raw, isBinary) => {
        if (isBinary) {
          this.handleBinary(clientId, raw as Buffer);
          return;
        }

        let msg: InboundMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.sendToClient(clientId, { type: 'error', message: 'Invalid JSON.' });
          return;
        }

        // Identification handshake — handled here before routing
        if (msg.type === 'client:identify') {
          const client = this.clients.get(clientId)!;
          const t = msg.clientType;
          client.type = (t === 'browser' || t === 'unity') ? t : 'unknown';
          console.log(`[WS] ${clientId} → ${client.type}`);
          this.sendToClient(clientId, { type: 'client:identified', clientId, clientType: client.type });
          if (client.type === 'unity') this.unityDisconnectReason = null;
          this.broadcastClients();
          this.onClientChange?.({ clientId, clientType: client.type, change: 'identified' });
          return;
        }

        this.messageHandler?.(clientId, msg);
      });

      ws.on('close', (code) => {
        console.log(`[WS] - ${clientId} (${code})`);
        const clientType = this.clients.get(clientId)?.type ?? 'unknown';
        const paused = this.inBackground.delete(clientId);
        const reason = this.droppedByHeartbeat.delete(clientId) ? 'heartbeat' : paused ? 'app-paused' : String(code);
        this.clients.delete(clientId);
        if (clientType === 'unity') this.unityDisconnectReason = reason;
        if (clientType !== 'unknown') {
          this.broadcastClients();
          this.onClientChange?.({ clientId, clientType, change: 'disconnected', reason });
        }
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error on ${clientId}: ${err.message}`);
      });
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Register the consumer for mic audio frames arriving from Unity. */
  onUnityBinary(handler: BinaryHandler): void {
    this.unityBinaryHandler = handler;
  }

  private handleBinary(clientId: string, data: Buffer): void {
    const client = this.clients.get(clientId);
    if (client?.type !== 'unity') return; // audio is only accepted from the AVP client
    this.unityBinaryHandler?.(clientId, data);
  }

  /** Low-rate JSON state updates that every client may care about. */
  broadcast(event: object): void {
    const msg = JSON.stringify(event);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === OPEN) ws.send(msg);
    }
  }

  /** JSON message to all clients of one type (e.g. admin-only monitoring). */
  sendTo(type: ClientType, event: object): void {
    const msg = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.type === type && client.ws.readyState === OPEN) client.ws.send(msg);
    }
  }

  sendToClient(clientId: string, event: object): void {
    const client = this.clients.get(clientId);
    if (client?.ws.readyState === OPEN) {
      client.ws.send(JSON.stringify(event));
    }
  }

  /** Binary frame (robot audio) to all clients of one type — normally 'unity'. */
  sendBinaryTo(type: ClientType, data: Buffer): void {
    for (const client of this.clients.values()) {
      if (client.type === type && client.ws.readyState === OPEN) client.ws.send(data);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Connected clients per type, as shown in the admin panel */
  get clientCounts(): Record<'browser' | 'unity', number> {
    const counts = { browser: 0, unity: 0 };
    for (const { type } of this.clients.values()) {
      if (type === 'browser' || type === 'unity') counts[type]++;
    }
    return counts;
  }

  get clientsStatus(): object {
    const unityInBackground = [...this.inBackground].some((id) => this.clients.get(id)?.type === 'unity');
    return { clients: this.clientCounts, unityDisconnectReason: this.unityDisconnectReason, unityInBackground };
  }

  /** A client reports a lifecycle event (Unity: about to be paused, focus changes). */
  noteLifecycle(clientId: string, event: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    console.log(`[WS] ${clientId} (${client.type}) lifecycle: ${event}`);
    const wasInBackground = this.inBackground.has(clientId);
    if (event === 'paused') this.inBackground.add(clientId);
    if (event === 'resumed') this.inBackground.delete(clientId);
    if (wasInBackground !== this.inBackground.has(clientId)) this.broadcastClients();
    this.onClientChange?.({ clientId, clientType: client.type, change: 'lifecycle', reason: event });
  }

  private broadcastClients(): void {
    this.broadcast({ type: 'clients:status', ...this.clientsStatus });
  }

  /** Drop clients that missed HEARTBEAT_MAX_MISSED pings in a row, ping the rest. */
  private checkHeartbeats(): void {
    for (const [clientId, client] of this.clients) {
      if (client.missedPings >= HEARTBEAT_MAX_MISSED) {
        console.log(`[WS] ${clientId} (${client.type}) missed ${client.missedPings} heartbeats — terminating`);
        this.droppedByHeartbeat.add(clientId);
        client.ws.terminate(); // fires 'close', which updates the registry
        continue;
      }
      client.missedPings++;
      client.ws.ping();
    }
  }
}
