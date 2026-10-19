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
| `clients:status`   | `clients: { browser, unity }`, `unityDisconnectReason`, `unityInBackground` | Number of identified clients per type; sent whenever one connects, identifies or disconnects, and when the Unity app enters or leaves the background. `unityDisconnectReason` says why the Unity app went away last (`app-paused` = while in the background, `heartbeat`, or a close code such as `1006`), `null` while it is connected. `unityInBackground`: the app reported `paused` and has not `resumed` yet — it keeps running (Unity `runInBackground`) and stays connected unless visionOS freezes it. The server pings every client every 10 s and drops those that missed three pings in a row (~30 s). `session:status` replies carry the same fields plus the current `robotState`. |
| `robot:state`      | `state: offline\|connecting\|idle\|listening\|thinking\|speaking` | Dialog state; drives robot animations and admin display. `speaking → idle` fires when Unity reports `avp:speech:done` (or after a fallback timeout derived from the streamed audio duration, if the report never arrives). |
| `robot:transcript` | `role: user\|assistant\|injected`, `text`, `final: bool` | Live transcript stream. Assistant text arrives incrementally (`final:false` deltas, then one `final:true` with the full utterance). |
| `robot:error`      | `message`                                      | Voice-pipeline error. |

### Server → unity only

| Type                  | Payload | Meaning |
|-----------------------|---------|---------|
| `server:heartbeat`    | —       | Every 5 s. The app reconnects when nothing at all arrived for ~15 s (half-open socket after a freeze or Wi-Fi drop). |
| `robot:speech:start`  | —       | An utterance begins; audio frames follow. |
| `robot:speech:end`    | —       | No more frames for this utterance. Unity finishes playing its buffer, then reports `avp:speech:done`. |
| `robot:speech:cancel` | —       | Participant barge-in: stop playback and flush any buffered audio immediately. |

### Client → server

| Type                | Payload                                   | Meaning |
|---------------------|-------------------------------------------|---------|
| `robot:voice:start` | —                                         | Start the provider voice session manually (testing only). During a study session the voice session starts/stops automatically with `session:start`/`session:end`, configured by the session's robot condition — Unity never needs to send this. |
| `robot:voice:stop`  | —                                         | Close the provider voice session. |
| `robot:inject`      | `text`, `mode: verbatim\|prompt`, `priority?: normal\|high`, `ttlMs?: number` | Make the robot speak: `verbatim` says the line word for word — split into one utterance per sentence, since the provider's audio tends to drop later sentences of a multi-sentence response (its transcript still shows them) — `prompt` opens a conversation about the given topic. Fires immediately when the robot is `idle`; otherwise queued. `high` priority jumps ahead of queued `normal` requests (announcements before small talk). A request whose `ttlMs` expires while queued is silently dropped. Ongoing speech and the participant are never interrupted. |
| `client:lifecycle`  | `event: paused\|resumed\|focus-lost\|focus-gained` | Unity app lifecycle (visionOS backgrounds Shared-Space apps that are out of view). The app runs in the background and stays connected while paused; all events go into the session log. |
| `avp:speech:done`   | —                                         | Unity finished playing the current utterance; completes the `speaking → idle` transition and releases the next queued speech request (re-broadcast to all clients). |

## Task session messages (existing)

Client → server: `session:start` (`params: { participantId, taskCondition:
easy|hard, robotCondition: talkative|quiet, ticketIntervalMs?, ticketJitter?,
sessionTimerMs?, ruleSchedule?, robotOverrides?, demo? }`), `session:begin`,
`session:pause`, `session:resume`, `session:end`, `session:status`,
`ticket:sort` (`ticketId`, `decision: ai|human`).

### Briefing

A session starts in status `briefing`: the voice session connects, the robot
says its scripted opener (verbatim), explains the task and asks whether the
participant is ready. The script depends on the robot condition (talkative:
greeting and name exchange first; quiet: a single factual line), see
`src/config/conditions.ts`. No tickets, rule changes, session
timer or scheduled robot speech run yet. The briefing ends — and the task
starts — when either

- the robot calls its `aufgabe_starten` tool after the participant confirmed
  they are ready (`trigger: "robot"`), or
- the admin panel sends `session:begin` (`trigger: "admin"`, manual override).

Then the server broadcasts `session:taskStarted` (`sessionId`, `trigger`,
`startedAt`, `timerDurationMs`); `startedAt` is the task start, which all task
timing (ticket dispatch, rule schedule, session timer) counts from.

`demo: true` skips the briefing and the voice session entirely — the task
starts immediately (`trigger: "demo"`) and the robot stays silent. Demo runs
are not logged at all (no CSV/JSONL, no `summary.csv` row); `participantId` is
optional for them. Their session IDs carry a `-demo-` tag.

`robotOverrides` (`{ voice?, voiceStyle?, smallTalkFirstAfterSec?,
smallTalkIntervalSec?, progressReportFirstAfterSec?,
progressReportIntervalSec?, impulseQuietSec? }`) lets the admin panel tweak
the robot's voice, speaking-style prompt and scheduler intervals per session;
omitted or invalid fields fall back to the condition preset in
`src/config/conditions.ts`. `impulseQuietSec` is the silence (nobody speaking,
robot idle) a due small-talk or progress-report impulse waits for before it
fires, so scheduled impulses never cut into an ongoing conversation; `0` only
waits for the robot to be idle.

Server → all: `session:started` (with `status: briefing`, `demo`),
`session:taskStarted`, `session:paused`, `session:resumed`,
`session:ended`, `session:poolExhausted`, `ticket:queued`, `ticket:sorted`,
`rule:changed`, `session:status` (reply).

Errors are reported to the offending client as `{"type":"error","message":"…"}`.
