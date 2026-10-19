import { OpenAiRealtimeSession, type RealtimeTool } from './openai-realtime';
import { resolveRobotConfig } from '../config/conditions';
import type { Hub } from '../hub';
import type { RobotConfig, RobotState } from '../types';

// ------------------------------------------------------------------ //
//  Dialog manager                                                      //
//                                                                      //
//  Single owner of the robot's conversational state. All inputs        //
//  converge here — provider events, Unity's avp:speech:done, and       //
//  speech requests (admin panel, briefing, small-talk scheduler and    //
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
//  - Nothing ever preempts the participant or an ongoing utterance.    //
//  - Verbatim lines are spoken one sentence at a time: the provider's  //
//    audio regularly drops the later sentences of a multi-sentence     //
//    response while its transcript still shows the full text. A        //
//    verbatim piece that produced no audio at all (the model answered  //
//    with a tool call instead) is retried once.                        //
//  - Uninterruptible requests (rule announcements) survive participant //
//    barge-in: playback continues instead of being flushed, and a      //
//    response the provider truncated mid-stream is re-queued so the    //
//    announcement is spoken again in full. Barge-in attempts are       //
//    reported via onInterruptionIgnored (participant error, logged).   //
// ------------------------------------------------------------------ //

export type SpeechSource = 'admin' | 'briefing' | 'scheduler' | 'task-event';

export interface SpeechRequest {
  text: string;
  mode: 'verbatim' | 'prompt';
  source: SpeechSource;
  priority?: 'normal' | 'high';
  ttlMs?: number;
  /** Participant barge-in neither flushes playback nor kills this
   *  utterance for good — a truncated response is spoken again in full. */
  uninterruptible?: boolean;
}

interface QueuedSpeech extends SpeechRequest {
  queuedAt: number;
  isRetry?: boolean;
}

interface CurrentSpeech {
  request: SpeechRequest;
  hadAudio: boolean;
  isRetry: boolean;
}

const PLAYBACK_FALLBACK_GRACE_MS = 2000;
const PCM_BYTES_PER_MS = 48; // PCM16 mono @ 24 kHz = 48 000 bytes/s

export class DialogManager {
  private session: OpenAiRealtimeSession | null = null;
  private state: RobotState = 'offline';
  private queue: QueuedSpeech[] = [];
  // When the robot last became idle — anything non-idle (participant
  // speaking, robot thinking/speaking) counts as an ongoing conversation
  private idleSince = Date.now();

  // Current utterance tracking (for the playback fallback timer)
  private utteranceBytes = 0;
  private utteranceStartedAt = 0;
  private playbackFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Uninterruptible utterance currently generating or playing; protection
  // lasts until the robot returns to idle. protectedResponsePending is true
  // only until the protected response itself finishes streaming — it tells
  // a truncated announcement apart from a follow-up response cancelled
  // later in the same playback window.
  private protectedSpeech: SpeechRequest | null = null;
  // Request whose response is generating right now (null for responses
  // the provider started itself after a participant turn)
  private currentSpeech: CurrentSpeech | null = null;
  private protectedResponsePending = false;

  // Hooks for the orchestrator — robot events land in the session JSONL log
  onTransition?: (from: RobotState, to: RobotState, reason: string) => void;
  onTranscript?: (role: 'user' | 'assistant' | 'injected', text: string) => void;
  onSpeechRequest?: (
    request: SpeechRequest,
    disposition: 'fired' | 'queued' | 'dropped',
    waitedMs?: number,
  ) => void;
  onInterruptionIgnored?: (request: SpeechRequest) => void;
  /** The model called one of the tools passed to startVoice(); the return
   *  value is sent back to the model as the call's result */
  onToolCall?: (name: string) => object;

  constructor(private hub: Hub) {}

  get currentState(): RobotState {
    return this.state;
  }

  /** How long the conversation has been silent; 0 while anyone is talking. */
  get quietForMs(): number {
    return this.state === 'idle' ? Date.now() - this.idleSince : 0;
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
  startVoice(config?: RobotConfig, tools: RealtimeTool[] = []): void {
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
      // Speaking style is steered via instructions — the Realtime API has
      // no separate voice-style field.
      instructions: `${robotConfig.systemPrompt}\n\nSprechweise:\n${robotConfig.voiceStyle}`,
      voice: robotConfig.voice,
      tools,
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

  /** Replace the tools the model may call, e.g. once the briefing is over. */
  setTools(tools: RealtimeTool[]): void {
    this.session?.setTools(tools);
  }

  /** Hidden system note the robot knows about but does not answer out loud. */
  addContext(text: string): void {
    this.session?.addSystemContext(text);
  }

  /** Mic PCM arriving from the unity client. */
  handleMicAudio(pcm: Buffer): void {
    this.session?.appendAudio(pcm);
  }

  // ------------------------------------------------------------------ //
  //  Speech requests (injection)                                         //
  // ------------------------------------------------------------------ //

  requestSpeech(request: SpeechRequest): void {
    // A session still connecting is fine: the request queues and drains on provider:ready
    if (!this.session) {
      this.error('Keine aktive Provider-Session — zuerst starten.');
      return;
    }

    // The first piece fires (if idle), the rest queue behind it in order —
    // also for 'high', which keeps FIFO order among highs
    const pieces = request.mode === 'verbatim' ? splitForSpeech(request.text) : [request.text];
    for (const text of pieces) this.enqueue({ ...request, text });
  }

  private enqueue(request: SpeechRequest): void {
    if (this.state === 'idle') {
      this.speak(request);
      this.onSpeechRequest?.(request, 'fired');
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
    this.onSpeechRequest?.(request, 'queued');
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
        if (this.currentSpeech) this.currentSpeech.hadAudio = true;
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
        // Barge-in against a protected utterance: keep playing, stay
        // 'speaking'. The participant's audio still reaches the provider
        // and the transcript, so the attempt is on record.
        if (this.state === 'speaking' && this.protectedSpeech) {
          console.log('[Dialog] barge-in ignored — uninterruptible announcement');
          this.onInterruptionIgnored?.(this.protectedSpeech);
          break;
        }
        // Participant barge-in while the robot talks: flush Unity's buffer
        if (this.state === 'speaking') {
          this.clearPlaybackFallback();
          this.hub.sendTo('unity', { type: 'robot:speech:cancel' });
        }
        this.transition('listening', 'provider:speechStarted');
        break;

      case 'speechStopped':
        // A protected utterance rode through the barge-in — stay 'speaking'
        if (this.state === 'speaking' && this.protectedSpeech) break;
        this.transition('thinking', 'provider:speechStopped');
        break;

      case 'responseDone':
        // A protected response the provider truncated (barge-in while audio
        // was still streaming) is re-queued so the announcement is spoken
        // again in full at the next idle moment.
        if (this.protectedResponsePending && this.protectedSpeech && event.status !== 'completed') {
          const retry = this.protectedSpeech;
          this.protectedSpeech = null;
          console.log(`[Dialog] protected speech ${event.status} mid-stream — re-queueing`);
          // Front of the queue: the remaining pieces of a split line must
          // not overtake the truncated one. The idle transition drains it.
          this.queue.unshift({ ...retry, queuedAt: Date.now() });
          this.onSpeechRequest?.(retry, 'queued');
        }
        this.protectedResponsePending = false;

        // A verbatim piece that completed without any audio (typically the
        // model called a tool instead of speaking) gets one more attempt
        // before anything else
        const finished = this.currentSpeech;
        this.currentSpeech = null;
        if (
          finished?.request.mode === 'verbatim' &&
          !finished.hadAudio &&
          !finished.isRetry &&
          event.status === 'completed'
        ) {
          console.log('[Dialog] verbatim speech produced no audio — retrying once');
          this.queue.unshift({ ...finished.request, queuedAt: Date.now(), isRetry: true });
          this.onSpeechRequest?.(finished.request, 'queued');
        }

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

      case 'toolCall':
        // Answer right away so the history stays well-formed; what the robot
        // says next is up to the hook (no response is triggered here). The
        // calling response's own responseDone still settles the state.
        console.log(`[Dialog] tool call: ${event.name}`);
        this.session?.addToolResult(event.callId, JSON.stringify(this.onToolCall?.(event.name) ?? { ok: true }));
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

  private speak(request: SpeechRequest & { isRetry?: boolean }): void {
    if (!this.session?.connected) return;

    this.currentSpeech = { request, hadAudio: false, isRetry: request.isRetry === true };
    this.protectedSpeech = request.uninterruptible ? request : null;
    this.protectedResponsePending = request.uninterruptible === true;

    // The nudge goes into the conversation as a system item, matching the
    // [SYSTEM: …] contract described in the session instructions. It must
    // NOT be sent as response.create instructions — those replace the whole
    // system prompt for that response instead of adding to it.
    const nudge =
      request.mode === 'verbatim'
        ? `[SYSTEM: VERBATIM] ${request.text}`
        : `[SYSTEM: PROMPT] ${request.text}`;

    this.transcript('injected', `[${request.source}/${request.mode}] ${request.text}`, true);
    this.session.addSystemContext(nudge);
    this.session.createResponse();
    // Response generation starts now; audio arrival moves us to 'speaking'
    this.transition('thinking', `speak:${request.source}`);
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const waitedMs = Date.now() - next.queuedAt;
      if (next.ttlMs != null && waitedMs > next.ttlMs) {
        console.log(`[Dialog] dropped expired speech request (${next.source}, waited ${waitedMs}ms)`);
        this.onSpeechRequest?.(next, 'dropped', waitedMs);
        continue;
      }
      this.speak(next);
      this.onSpeechRequest?.(next, 'fired', waitedMs);
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
    // Protection lasts exactly as long as the utterance: reaching idle or
    // offline means nothing protected is generating or playing anymore.
    if (to === 'idle' || to === 'offline') {
      this.protectedSpeech = null;
      this.protectedResponsePending = false;
    }
    const from = this.state;
    this.state = to;
    if (to === 'idle') this.idleSince = Date.now();
    console.log(`[Dialog] ${from} → ${to} (${reason})`);
    this.onTransition?.(from, to, reason);
    this.hub.broadcast({ type: 'robot:state', state: to });
  }

  private transcript(role: 'user' | 'assistant' | 'injected', text: string, final: boolean): void {
    this.hub.broadcast({ type: 'robot:transcript', role, text, final });
    if (final) this.onTranscript?.(role, text);
  }

  private error(message: string): void {
    console.error(`[Dialog] error: ${message}`);
    this.hub.broadcast({ type: 'robot:error', message });
  }
}

/**
 * Splits a verbatim line into its sentences, each spoken as its own
 * response. Measured against the provider: single-sentence responses
 * arrived complete, while the second sentence of a response was lost in
 * most runs even for short (~5 s) utterances.
 */
export function splitForSpeech(text: string): string[] {
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.length > 0 ? sentences : [text];
}
