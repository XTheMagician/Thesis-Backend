import WebSocket from 'ws';

// ------------------------------------------------------------------ //
//  OpenAI Realtime API client (speech-to-speech over WebSocket)        //
//                                                                      //
//  Audio in both directions is PCM16, 24 kHz, mono. The API's server-  //
//  side VAD detects turn ends and generates responses automatically.   //
// ------------------------------------------------------------------ //

export type RealtimeEvent =
  | { kind: 'ready' }
  | { kind: 'audio'; pcm: Buffer }
  | { kind: 'assistantTranscriptDelta'; text: string }
  | { kind: 'assistantTranscriptDone'; text: string }
  | { kind: 'userTranscript'; text: string }
  | { kind: 'speechStarted' }
  | { kind: 'speechStopped' }
  | { kind: 'responseDone' }
  | { kind: 'error'; message: string }
  | { kind: 'closed' };

export interface RealtimeSessionOptions {
  apiKey: string;
  model: string;
  instructions: string;
  voice: string;
  onEvent: (event: RealtimeEvent) => void;
}

export class OpenAiRealtimeSession {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private opts: RealtimeSessionOptions) {}

  connect(): void {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.opts.model)}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: this.opts.instructions,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              // gpt-4o-mini-transcribe hallucinates far less on silence than
              // whisper-1 (which infamously transcribes noise as German TV
              // subtitle credits); near_field suits a close-talking headset/AVP
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'de' },
              noise_reduction: { type: 'near_field' },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: this.opts.voice,
            },
          },
        },
      });
    });

    ws.on('message', (raw) => {
      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleServerEvent(event);
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      if (!this.closedByUs) {
        this.opts.onEvent({ kind: 'error', message: `Provider connection closed (${code}) ${reason.toString()}`.trim() });
      }
      this.opts.onEvent({ kind: 'closed' });
    });

    ws.on('error', (err) => {
      this.opts.onEvent({ kind: 'error', message: err.message });
    });

    ws.on('unexpected-response', (_req, res) => {
      // e.g. 401 invalid API key — surface the HTTP status instead of a silent close
      this.opts.onEvent({ kind: 'error', message: `Provider rejected connection: HTTP ${res.statusCode}` });
    });
  }

  /** Forward raw PCM16 (24 kHz mono) mic audio into the provider's input buffer. */
  appendAudio(pcm: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /**
   * Make the robot speak now. The instructions apply to this response only
   * (they are not stored in the conversation); the resulting utterance is,
   * so the participant can answer and the conversation continues naturally.
   */
  createResponse(instructions: string): void {
    this.send({ type: 'response.create', response: { instructions } });
  }

  /**
   * Insert a hidden system-context item into the conversation history —
   * e.g. a task event the robot should know about and may refer back to.
   * Call createResponse() afterwards if the robot should react out loud.
   */
  addSystemContext(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(event: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private handleServerEvent(event: { type: string; [key: string]: unknown }): void {
    const emit = this.opts.onEvent;

    switch (event.type) {
      case 'session.updated':
        emit({ kind: 'ready' });
        break;

      case 'response.output_audio.delta':
        emit({ kind: 'audio', pcm: Buffer.from(event.delta as string, 'base64') });
        break;

      case 'response.output_audio_transcript.delta':
        emit({ kind: 'assistantTranscriptDelta', text: event.delta as string });
        break;

      case 'response.output_audio_transcript.done':
        emit({ kind: 'assistantTranscriptDone', text: event.transcript as string });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        emit({ kind: 'userTranscript', text: event.transcript as string });
        break;

      case 'input_audio_buffer.speech_started':
        emit({ kind: 'speechStarted' });
        break;

      case 'input_audio_buffer.speech_stopped':
        emit({ kind: 'speechStopped' });
        break;

      case 'response.done':
        emit({ kind: 'responseDone' });
        break;

      case 'error': {
        const err = event.error as { message?: string } | undefined;
        emit({ kind: 'error', message: err?.message ?? 'Unknown provider error' });
        break;
      }
    }
  }
}
