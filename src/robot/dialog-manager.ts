import { OpenAiRealtimeSession } from './openai-realtime';
import { resolveRobotConfig } from '../config/conditions';
import type { Hub } from '../hub';
import type { RobotConfig, RobotState } from '../types';

// ------------------------------------------------------------------ //
//  Dialog manager                                                      //
//                                                                      //
//  Single owner of the robot's conversational state. All inputs        //
//  converge here — provider events, Unity's avp:speech:done, and       //
//  speech requests (admin panel, later: small-talk scheduler and       //
//  task events) — and it alone decides state transitions and when a    //
//  queued speech request may fire.                                     //
//                                                                      //
//  Key rules:                                                          //
//  - speaking → idle waits for actual playback completion              //
//    (avp:speech:done), with a fallback timeout derived from the       //
//    streamed audio duration so a lost client can't wedge the state.   //
//  - Speech requests only fire in idle; otherwise they queue.          //
//    priority 'high' jumps ahead of queued 'normal' requests           //
//    (announcements before small talk); TTL expires stale requests.    //
//  - Nothing ever preempts the participant or an ongoing utterance     //
//    (a future `interrupt` flag could cancel ongoing robot speech      //
//    via response.cancel + robot:speech:cancel if piloting shows       //
//    announcements arrive too late).                                   //
// ------------------------------------------------------------------ //

export type SpeechSource = 'admin' | 'scheduler' | 'task-event';

export interface SpeechRequest {
  text: string;
  mode: 'verbatim' | 'prompt';
  source: SpeechSource;
  priority?: 'normal' | 'high';
  ttlMs?: number;
}

interface QueuedSpeech extends SpeechRequest {
  queuedAt: number;
}

const PLAYBACK_FALLBACK_GRACE_MS = 2000;
const PCM_BYTES_PER_MS = 48; // PCM16 mono @ 24 kHz = 48 000 bytes/s

export class DialogManager {
  private session: OpenAiRealtimeSession | null = null;
  private state: RobotState = 'offline';
  private queue: QueuedSpeech[] = [];

  // Current utterance tracking (for the playback fallback timer)
  private utteranceBytes = 0;
  private utteranceStartedAt = 0;
  private playbackFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Hook for the orchestrator: called on every state transition (for JSONL logging). */
  onTransition?: (from: RobotState, to: RobotState, reason: string) => void;

  constructor(private hub: Hub) {}

  get currentState(): RobotState {
    return this.state;
  }

  // ------------------------------------------------------------------ //
  //  Voice session lifecycle                                             //
  // ------------------------------------------------------------------ //

  /**
   * Start the provider voice session. Called with the participant's resolved
   * RobotConfig when a study session starts; without arguments (manual
   * robot:voice:start from the test page) it falls back to the talkative
   * preset. An already-running voice session is replaced, so a study session
   * always speaks with its own condition's prompt and voice.
   */
  startVoice(config?: RobotConfig): void {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'sk-REPLACE_ME') {
      this.error('OPENAI_API_KEY is not set in .env');
      return;
    }

    if (this.session) {
      console.log('[Dialog] restarting voice session with new config');
      this.stopVoice();
    }

    const robotConfig = config ?? resolveRobotConfig('talkative');
    this.transition('connecting', 'voice:start');

    const session = new OpenAiRealtimeSession({
      apiKey,
      model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
      instructions: robotConfig.systemPrompt,
      voice: robotConfig.voice,
      // Ignore events from a superseded session (e.g. its close racing a restart)
      onEvent: (event) => {
        if (this.session !== session) return;
        this.handleProviderEvent(event);
      },
    });

    this.session = session;
    session.connect();
  }

  stopVoice(): void {
    if (!this.session) return;
    const session = this.session;
    this.session = null; // the identity guard filters this session's late events
    session.close();
    this.clearPlaybackFallback();
    this.queue = [];
    this.transition('offline', 'voice:stop');
  }

  /** Mic PCM arriving from the unity client. */
  handleMicAudio(pcm: Buffer): void {
    this.session?.appendAudio(pcm);
  }

  // ------------------------------------------------------------------ //
  //  Speech requests (injection)                                         //
  // ------------------------------------------------------------------ //

  requestSpeech(request: SpeechRequest): void {
    if (!this.session?.connected) {
      this.error('Keine aktive Provider-Session — zuerst starten.');
      return;
    }

    if (this.state === 'idle') {
      this.speak(request);
      return;
    }

    // Robot or participant is busy — queue for the next idle moment
    const entry: QueuedSpeech = { ...request, queuedAt: Date.now() };
    if (request.priority === 'high') {
      // Ahead of all queued normals, behind earlier highs (FIFO among highs)
      const firstNormal = this.queue.findIndex((q) => q.priority !== 'high');
      if (firstNormal === -1) this.queue.push(entry);
      else this.queue.splice(firstNormal, 0, entry);
    } else {
      this.queue.push(entry);
    }
    console.log(`[Dialog] queued speech (${request.source}, ${request.priority ?? 'normal'}), queue length ${this.queue.length}`);
  }

  /** Unity reports its playback buffer ran empty (avp:speech:done). */
  handlePlaybackDone(): void {
    if (this.state !== 'speaking') return;
    this.clearPlaybackFallback();
    this.transition('idle', 'avp:speech:done');
    this.drainQueue();
  }

  // ------------------------------------------------------------------ //
  //  Provider events                                                     //
  // ------------------------------------------------------------------ //

  private handleProviderEvent(event: import('./openai-realtime').RealtimeEvent): void {
    switch (event.kind) {
      case 'ready':
        this.transition('idle', 'provider:ready');
        this.drainQueue();
        break;

      case 'audio':
        if (this.state !== 'speaking') {
          this.utteranceBytes = 0;
          this.utteranceStartedAt = Date.now();
          this.hub.sendTo('unity', { type: 'robot:speech:start' });
          this.transition('speaking', 'provider:audioStart');
        }
        this.utteranceBytes += event.pcm.length;
        this.hub.sendBinaryTo('unity', event.pcm);
        break;

      case 'assistantTranscriptDelta':
        this.transcript('assistant', event.text, false);
        break;
      case 'assistantTranscriptDone':
        this.transcript('assistant', event.text, true);
        break;
      case 'userTranscript':
        this.transcript('user', event.text, true);
        break;

      case 'speechStarted':
        // Participant barge-in while the robot talks: flush Unity's buffer
        if (this.state === 'speaking') {
          this.clearPlaybackFallback();
          this.hub.sendTo('unity', { type: 'robot:speech:cancel' });
        }
        this.transition('listening', 'provider:speechStarted');
        break;

      case 'speechStopped':
        this.transition('thinking', 'provider:speechStopped');
        break;

      case 'responseDone':
        if (this.state === 'speaking') {
          // Provider finished streaming; stay 'speaking' until Unity confirms
          // playback (or the fallback timer fires).
          this.hub.sendTo('unity', { type: 'robot:speech:end' });
          this.armPlaybackFallback();
        } else {
          // Response produced no audio (e.g. cancelled early) — back to idle
          this.transition('idle', 'provider:responseDone');
          this.drainQueue();
        }
        break;

      case 'error':
        this.error(event.message);
        break;

      case 'closed':
        this.session = null;
        this.clearPlaybackFallback();
        this.queue = [];
        this.transition('offline', 'provider:closed');
        break;
    }
  }

  // ------------------------------------------------------------------ //
  //  Internals                                                            //
  // ------------------------------------------------------------------ //

  private speak(request: SpeechRequest): void {
    if (!this.session?.connected) return;

    const instructions =
      request.mode === 'verbatim'
        ? `Sag wörtlich und ohne Ergänzungen oder Kommentare: "${request.text}"`
        : `Initiiere von dir aus ein kurzes Gespräch mit dem Teilnehmer über folgendes Thema: ${request.text}. Halte dich an ein bis zwei Sätze.`;

    this.transcript('injected', `[${request.source}/${request.mode}] ${request.text}`, true);
    this.session.createResponse(instructions);
    // Response generation starts now; audio arrival moves us to 'speaking'
    this.transition('thinking', `speak:${request.source}`);
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.ttlMs != null && Date.now() - next.queuedAt > next.ttlMs) {
        console.log(`[Dialog] dropped expired speech request (${next.source}, waited ${Date.now() - next.queuedAt}ms)`);
        continue;
      }
      this.speak(next);
      return; // one at a time; the next drains after this utterance completes
    }
  }

  private armPlaybackFallback(): void {
    const durationMs = this.utteranceBytes / PCM_BYTES_PER_MS;
    const elapsed = Date.now() - this.utteranceStartedAt;
    const remaining = Math.max(0, durationMs - elapsed) + PLAYBACK_FALLBACK_GRACE_MS;

    this.clearPlaybackFallback();
    this.playbackFallbackTimer = setTimeout(() => {
      if (this.state !== 'speaking') return;
      console.log('[Dialog] no avp:speech:done received — falling back to idle');
      this.transition('idle', 'playback:fallbackTimeout');
      this.drainQueue();
    }, remaining);
  }

  private clearPlaybackFallback(): void {
    if (this.playbackFallbackTimer) {
      clearTimeout(this.playbackFallbackTimer);
      this.playbackFallbackTimer = null;
    }
  }

  private transition(to: RobotState, reason: string): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    console.log(`[Dialog] ${from} → ${to} (${reason})`);
    this.onTransition?.(from, to, reason);
    this.hub.broadcast({ type: 'robot:state', state: to });
  }

  private transcript(role: 'user' | 'assistant' | 'injected', text: string, final: boolean): void {
    this.hub.broadcast({ type: 'robot:transcript', role, text, final });
  }

  private error(message: string): void {
    console.error(`[Dialog] error: ${message}`);
    this.hub.broadcast({ type: 'robot:error', message });
  }
}
