import { OpenAiRealtimeSession } from './openai-realtime';
import { resolveRobotConfig } from '../config/conditions';
import type { Hub } from '../hub';

// ------------------------------------------------------------------ //
//  Voice pipeline test controller                                      //
//                                                                      //
//  Temporary harness for validating the provider connection: the       //
//  frontend test page identifies itself as a 'unity' client and        //
//  streams mic PCM up; robot audio streams back down the same path     //
//  the real AVP client will use. Status and transcripts go out as      //
//  JSON so any connected client can display them.                      //
// ------------------------------------------------------------------ //

export class VoiceTestController {
  private session: OpenAiRealtimeSession | null = null;

  constructor(private hub: Hub) {}

  start(): void {
    if (this.session) {
      this.status('error', 'Voice test already running — stop it first.');
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'sk-REPLACE_ME') {
      this.status('error', 'OPENAI_API_KEY is not set in .env');
      return;
    }

    this.status('connecting', 'Connecting to OpenAI Realtime…');

    const session = new OpenAiRealtimeSession({
      apiKey,
      model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
      instructions: resolveRobotConfig('talkative').systemPrompt,
      voice: 'marin',
      onEvent: (event) => {
        switch (event.kind) {
          case 'ready':
            this.status('ready', 'Provider session ready — sprich einfach los.');
            break;
          case 'audio':
            this.hub.sendBinaryTo('unity', event.pcm);
            break;
          case 'assistantTranscriptDelta':
            this.hub.broadcast({ type: 'test:voice:transcript', role: 'assistant', text: event.text, final: false });
            break;
          case 'assistantTranscriptDone':
            this.hub.broadcast({ type: 'test:voice:transcript', role: 'assistant', text: event.text, final: true });
            break;
          case 'userTranscript':
            this.hub.broadcast({ type: 'test:voice:transcript', role: 'user', text: event.text, final: true });
            break;
          case 'speechStarted':
            this.status('listening', 'Sprache erkannt…');
            break;
          case 'speechStopped':
            this.status('thinking', 'Antwort wird generiert…');
            break;
          case 'responseDone':
            this.status('ready', 'Antwort abgeschlossen.');
            break;
          case 'error':
            this.status('error', event.message);
            break;
          case 'closed':
            this.session = null;
            this.status('stopped', 'Provider session closed.');
            break;
        }
      },
    });

    this.session = session;
    session.connect();
  }

  stop(): void {
    if (!this.session) return;
    this.session.close();
    this.session = null;
  }

  /** Mic PCM arriving from the (test) unity client. */
  handleMicAudio(pcm: Buffer): void {
    this.session?.appendAudio(pcm);
  }

  /**
   * Make the robot speak on command.
   * 'verbatim' — say the given line word for word (rule announcements).
   * 'prompt'   — open a conversation about the given topic (small talk).
   */
  inject(text: string, mode: 'verbatim' | 'prompt'): void {
    if (!this.session?.connected) {
      this.status('error', 'Keine aktive Provider-Session — zuerst starten.');
      return;
    }

    const instructions =
      mode === 'verbatim'
        ? `Sag wörtlich und ohne Ergänzungen oder Kommentare: "${text}"`
        : `Initiiere von dir aus ein kurzes Gespräch mit dem Teilnehmer über folgendes Thema: ${text}. Halte dich an ein bis zwei Sätze.`;

    this.hub.broadcast({ type: 'test:voice:transcript', role: 'injected', text: `[${mode}] ${text}`, final: true });
    this.session.createResponse(instructions);
  }

  get active(): boolean {
    return this.session !== null;
  }

  private status(state: string, message: string): void {
    console.log(`[VoiceTest] ${state}: ${message}`);
    this.hub.broadcast({ type: 'test:voice:status', state, message });
  }
}
