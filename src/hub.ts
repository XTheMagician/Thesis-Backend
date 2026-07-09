import { randomUUID } from 'crypto';
import type { WebSocketServer } from 'ws';
import type { ClientType, InboundMessage, WsClient } from './types';

const OPEN = 1; // WebSocket.OPEN

type MessageHandler = (clientId: string, msg: InboundMessage) => void;
type BinaryHandler = (clientId: string, data: Buffer) => void;

/**
 * Client registry and transport layer.
 *
 * Owns all connected sockets, the identify handshake, and the split
 * between JSON control messages and binary frames. Binary frames from
 * the Unity client (mic PCM audio) are passed to the registered binary
 * handler — the voice-provider session will register itself here.
 */
export class Hub {
  private clients = new Map<string, WsClient>();
  private messageHandler: MessageHandler | null = null;
  private unityBinaryHandler: BinaryHandler | null = null;

  constructor(wss: WebSocketServer) {
    wss.on('connection', (ws) => {
      const clientId = randomUUID();
      this.clients.set(clientId, { ws, type: 'unknown' });
      console.log(`[WS] + ${clientId}`);

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
          return;
        }

        this.messageHandler?.(clientId, msg);
      });

      ws.on('close', () => {
        console.log(`[WS] - ${clientId}`);
        this.clients.delete(clientId);
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
}
