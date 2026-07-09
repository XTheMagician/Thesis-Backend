# WebSocket Protocol

Single WebSocket endpoint, shared with HTTP on the same port (default `3000`).
All control messages are JSON text frames with a `type` field. Audio is raw
binary frames (no envelope).

## Connection & handshake

1. Client connects to `ws://<host>:3000`.
2. Server sends `{"type":"server:hello","clientId":"<uuid>"}`.
3. Client identifies: `{"type":"client:identify","clientType":"unity"}`
   (or `"browser"`). Server confirms with `client:identified`.
4. On (re)connect, clients may send `{"type":"session:status"}` to receive a
   full snapshot of the running task session.

Unidentified clients receive broadcasts but cannot send or receive audio.

## Binary audio frames

| Direction       | Content                        |
|-----------------|--------------------------------|
| unity → server  | Participant microphone audio   |
| server → unity  | Robot speech audio             |

Format both ways: **PCM16, little-endian, mono, 24 kHz**, raw samples without
header. Recommended chunk size ~100–200 ms (4800–9600 samples). Binary frames
are only accepted from / sent to clients identified as `unity`.

Convention: Unity should gate its microphone locally while `robot:state` is
`speaking` (don't stream the robot's own voice back into the pipeline) unless
echo cancellation is confirmed reliable on device.

## Robot / voice messages

### Server → all clients

| Type               | Payload                                        | Meaning |
|--------------------|------------------------------------------------|---------|
| `robot:state`      | `state: offline\|connecting\|idle\|listening\|thinking\|speaking` | Dialog state; drives robot animations and admin display. `speaking → idle` fires when Unity reports `avp:speech:done` (or after a fallback timeout derived from the streamed audio duration, if the report never arrives). |
| `robot:transcript` | `role: user\|assistant\|injected`, `text`, `final: bool` | Live transcript stream. Assistant text arrives incrementally (`final:false` deltas, then one `final:true` with the full utterance). |
| `robot:error`      | `message`                                      | Voice-pipeline error. |

### Server → unity only

| Type                  | Payload | Meaning |
|-----------------------|---------|---------|
| `robot:speech:start`  | —       | An utterance begins; audio frames follow. |
| `robot:speech:end`    | —       | No more frames for this utterance. Unity finishes playing its buffer, then reports `avp:speech:done`. |
| `robot:speech:cancel` | —       | Participant barge-in: stop playback and flush any buffered audio immediately. |

### Client → server

| Type                | Payload                                   | Meaning |
|---------------------|-------------------------------------------|---------|
| `robot:voice:start` | —                                         | Start the provider voice session (manual/admin; later tied to session lifecycle). |
| `robot:voice:stop`  | —                                         | Close the provider voice session. |
| `robot:inject`      | `text`, `mode: verbatim\|prompt`, `priority?: normal\|high`, `ttlMs?: number` | Make the robot speak: `verbatim` says the line word for word, `prompt` opens a conversation about the given topic. Fires immediately when the robot is `idle`; otherwise queued. `high` priority jumps ahead of queued `normal` requests (announcements before small talk). A request whose `ttlMs` expires while queued is silently dropped. Ongoing speech and the participant are never interrupted. |
| `avp:speech:done`   | —                                         | Unity finished playing the current utterance; completes the `speaking → idle` transition and releases the next queued speech request (re-broadcast to all clients). |

## Task session messages (existing)

Client → server: `session:start` (`params: { participantId, taskCondition:
easy|hard, robotCondition: talkative|quiet, ticketIntervalMs?, ticketJitter?,
sessionTimerMs?, ruleSchedule? }`), `session:pause`, `session:resume`,
`session:end`, `session:status`, `ticket:sort` (`ticketId`, `decision: ai|human`).

Server → all: `session:started`, `session:paused`, `session:resumed`,
`session:ended`, `session:poolExhausted`, `ticket:queued`, `ticket:sorted`,
`rule:changed`, `session:status` (reply).

Errors are reported to the offending client as `{"type":"error","message":"…"}`.
