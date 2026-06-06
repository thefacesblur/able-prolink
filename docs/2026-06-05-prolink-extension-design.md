# Ableton ProLink Extension — Design Spec

**Date:** 2026-06-05
**Status:** Approved

---

## Overview

An Ableton Live Extension that captures Pioneer DJ equipment performance data in real-time and reconstructs it as an annotated Ableton Arrangement. The user records their DJ set audio via an audio interface into Ableton while the extension simultaneously listens to the Pioneer Pro DJ Link network and creates deck activity tracks, on-air clips, cue point markers, and live tempo automation alongside the recording.

---

## Scope & Constraints

**In scope (MVP):**
- Two-deck capture (XDJ-RX or XDJ-XZ hardware)
- On-air clip creation driven by `isOnAir` status transitions
- Pitch-adjusted BPM tracking (`trackBPM × (1 + sliderPitch)`)
- Live `song.tempo` updates following the master deck
- Cue point markers: track loads, on-air start/end, loops, hot cue positions from metadata
- Track metadata prefetch (title, artist, BPM, duration, cue points) via `prolink-connect` remote DB
- Status webview showing live deck state and session timer
- Context menu Start/Stop Capture commands
- EventStore flushed to JSON at session end

**Out of scope (post-MVP):**
- Real-time hot cue trigger detection (not available in Pro DJ Link status packets)
- Pitch-adjusted clip audio warping
- Rekordbox metadata integration (key, playlist, rating)
- Distribution as `.ablx` (Developer Mode only for MVP)
- More than 4 decks

**Known constraints:**
1. Ableton must be open during the DJ set — the extension only runs inside Live
2. Rekordbox cannot run on the same machine — conflicts with prolink-connect on UDP ports
3. Hot cue markers are offset from track start; seeks or cue jumps before going on-air will shift their positions
4. Timeline bar accuracy depends on `song.tempo` staying in sync with the master deck; rapid pitch slider sweeps may cause momentary bar drift
5. XDJ-RX presents 2 players (IDs 1 & 2); XDJ-XZ presents 4. UI is optimised for 2 decks but up to 4 are handled
6. Deck tracks are MIDI clips with no notes — purely visual markers. Audio recording is the user's responsibility via their audio interface input tracks

---

## Architecture & Data Flow

```
XDJ-RX/XZ (Pro DJ Link UDP multicast)
        │
        ▼
  NetworkListener           bringOnline() → autoconfigFromPeers() → connect()
    │            │
    │            └─ statusEmitter.on('status')  ← raw CDJStatus.State ~150ms
    │
    ├─ mixstatus.on('setStarted') / ('setEnded')
    └─ isOnAir transition detection (from raw status stream)
        │
        ▼
   EventStore                 append-only in-memory log
   { timestamp, deviceId,     flushed to storageDirectory/sessions/<ts>.json on stop
     type, payload }
        │
        ▼
   Dispatcher                 reads EventStore tail, applies to Live
        │
   ┌────┴─────────────────────────────────────┐
   ▼                                           ▼
AbletonWriter                            ViewBridge
 • create "Deck 1" / "Deck 2" tracks      • posts STATE_UPDATE to webview
 • create/resize MIDI clips               • receives STOP_CAPTURE message
 • create cue points (markers)
 • set song.tempo on master BPM change
```

**Session lifecycle:**
1. User right-clicks any track → "ProLink: Start Capture"
2. Progress dialog: `bringOnline()` → `autoconfigFromPeers()` (10s timeout) → `connect()`
3. Deck 1 + Deck 2 MIDI tracks created; `sessionOriginBars` and `captureStartMs` recorded
4. Events flow: NetworkListener → EventStore → Dispatcher → AbletonWriter + ViewBridge
5. User clicks "Stop Capture" (webview button or context menu) → disconnect, flush EventStore to JSON, close webview

**Connection error handling:** If `autoconfigFromPeers()` times out after 10s, the progress dialog shows "No Pioneer devices found — check that the XDJ is on the same network" and aborts cleanly.

**Timeline alignment formula:**
```
arrangementPosition = sessionOriginBars
  + (eventMs − captureStartMs) / 1000 × masterBPM / 60 / 4
```
`masterBPM` defaults to `song.tempo` at capture start before any deck plays. Updated on each `BPM_CHANGE` event where `isMasterDevice = true`. This stays accurate because `song.tempo` is updated in real-time to match the master deck.

---

## Event Types & EventStore Schema

```ts
type ProLinkEvent =
  | { type: 'SESSION_START';   timestamp: number; arrangementOriginBars: number }
  | { type: 'TRACK_LOADED';    timestamp: number; deviceId: number;
      trackId: number; trackSlot: MediaSlot; trackType: TrackType }
      // triggers async metadata prefetch so it's ready when ON_AIR fires
  | { type: 'TRACK_METADATA';  timestamp: number; deviceId: number;
      track: { title: string; artist: string; bpm: number; durationSecs: number;
               cuePoints: CueAndLoop[] } }
  | { type: 'ON_AIR_START';    timestamp: number; deviceId: number }
      // clip created here, named from cached TRACK_METADATA
      // isOnAir transitions debounced by 1 status packet (~150ms) to suppress flicker
  | { type: 'ON_AIR_END';      timestamp: number; deviceId: number }
      // clip resized to actual elapsed on-air duration
  | { type: 'PITCH_CHANGE';    timestamp: number; deviceId: number;
      trackBPM: number; sliderPitch: number; effectivePitch: number;
      adjustedBPM: number }
      // debounced 200ms; only emitted when sliderPitch delta > 0.001
  | { type: 'BPM_CHANGE';      timestamp: number; deviceId: number;
      isMasterDevice: boolean; adjustedBPM: number }
      // song.tempo updated only when isMasterDevice = true
  | { type: 'LOOP_ENTER';      timestamp: number; deviceId: number }
  | { type: 'LOOP_EXIT';       timestamp: number; deviceId: number }
  | { type: 'MASTER_CHANGE';   timestamp: number; deviceId: number }
  | { type: 'SET_STARTED';     timestamp: number }
  | { type: 'SET_ENDED';       timestamp: number }
  | { type: 'SESSION_STOP';    timestamp: number }
```

**EventStore interface:**
```ts
class EventStore {
  append(event: ProLinkEvent): void
  getAll(): readonly ProLinkEvent[]
  flushToDisk(path: string): Promise<void>
}
```

The Dispatcher processes events synchronously on append. No queue needed — prolink-connect events arrive at human timescales.

---

## Ableton Artifacts

### Tracks

Two MIDI tracks created at `SESSION_START`:
- `"Deck 1"` — one MIDI clip per on-air segment for player 1
- `"Deck 2"` — one MIDI clip per on-air segment for player 2

MIDI tracks (not audio) are used because the deck clips are visual markers only — the actual audio is the user's audio interface recording tracks. No audio file references needed.

### Clips (one per on-air segment)

| Phase | Action |
|---|---|
| `ON_AIR_START` | Transaction 1: create MIDI clip at calculated arrangement position. Initial size = `durationSecs × adjustedBPM / 60 / 4` bars (from cached metadata), or 4 bars if metadata not yet available |
| `ON_AIR_START` | Transaction 2: name clip `"Artist – Title"` (from cached metadata), or `"Deck N"` provisionally if metadata not yet available |
| `TRACK_METADATA` (if clip already open) | Rename open clip from `"Deck N"` to `"Artist – Title"` and resize to `durationSecs × adjustedBPM / 60 / 4` if still provisionally sized |
| `ON_AIR_END` | Resize clip to actual: `(endMs − startMs) / 1000 × currentBPM / 60 / 4` bars |

### Cue Points (Arrangement locators)

| Trigger | Label |
|---|---|
| `ON_AIR_START` | `"▶ D1: Artist – Title"` |
| `ON_AIR_END` | `"■ D1"` |
| `LOOP_ENTER` | `"↺ Loop D1"` |
| `LOOP_EXIT` | `"↺ Loop End D1"` |
| Hot cues from metadata (at `ON_AIR_START`) | `"D1 Hot Cue A"` … positioned at `clipStart + (hotcue.offsetMs / 1000 × masterBPM / 60 / 4)` |

**Hot cue limitation:** offsets are from track start. If the DJ seeks or uses a cue jump before going on-air, positions will be inaccurate.

### Tempo

`song.tempo` is set on every `BPM_CHANGE` event where `isMasterDevice = true`. Uses `adjustedBPM = trackBPM × (1 + sliderPitch)`. Debounced 200ms to suppress jog-wheel noise.

---

## Commands & Status Webview

### Context Menu Commands

Registered on both `AudioTrack` and `MidiTrack` scopes. Only one action is visible at a time — Start and Stop are dynamically swapped via unregister/register:

- At rest: `"ProLink: Start Capture"`
- While capturing: `"ProLink: Stop Capture"`

### Status Webview Layout

```
┌──────────────────────────────────────┐
│  ProLink Capture         ● 00:42:17  │
├──────────────────────────────────────┤
│  Connected — XDJ-RX (2 players)      │
├──────────────────┬───────────────────┤
│   DECK 1  ON AIR │  DECK 2           │
│ ─────────────── │ ──────────────── │
│  Fisher          │  Peggy Gou        │
│  Losing It       │  You Know That I… │
│  128.0 BPM ★    │  124.5 BPM        │
│  (master)        │                   │
├──────────────────┴───────────────────┤
│           [ Stop Capture ]           │
└──────────────────────────────────────┘
```

`★` = master deck. "ON AIR" badge reflects live `isOnAir` status. BPM shows `adjustedBPM`.

### Webview Message Protocol

```ts
// Extension → Webview (pushed on every status change)
{ type: 'STATE_UPDATE', payload: {
    sessionMs: number,
    connection: 'connecting' | 'connected' | 'failed',
    decks: Record<number, {
      isOnAir: boolean, isMaster: boolean,
      title: string, artist: string, adjustedBPM: number
    }>
  }
}

// Webview → Extension
{ type: 'STOP_CAPTURE' }
```

---

## File Structure

```
src/
  extension.ts              # activate(), command registration, wires all modules
  prolink/
    network.ts              # bringOnline → autoconfigFromPeers → connect/disconnect
    listener.ts             # statusEmitter + mixstatus subscriptions → EventStore.append()
    types.ts                # ProLinkEvent union type
  store/
    EventStore.ts           # append-only array + flushToDisk()
  dispatch/
    Dispatcher.ts           # reads EventStore tail, calls AbletonWriter + ViewBridge
    AbletonWriter.ts        # all SDK calls: createTrack, createMidiClip, cuePoint, setTempo
    ViewBridge.ts           # pushes STATE_UPDATE to webview, handles STOP_CAPTURE
  commands/
    startCapture.ts         # progress dialog, network connect, session init
    stopCapture.ts          # disconnect, flush EventStore, close webview
  ui/
    statusDialog.html       # inlined status webview (bundled as text by esbuild)
  utils/
    timing.ts               # arrangementPosition() formula
    debounce.ts             # 200ms BPM debounce utility
```

---

## Project Setup Notes

**Transform existing repo:** Update `manifest.json` name, add `prolink-connect` to `package.json`, replace `src/`. All existing build scaffolding (build.ts, vendor tgz, esbuild config) is reused.

**prolink-connect native module:** The library depends on `better-sqlite3` (native C++ addon) for its `localdb` module. For XDJ-RX/XZ, metadata is fetched via the remote database protocol — `better-sqlite3` is not invoked. Mark it as `external` in esbuild to be safe. The extension runs in Developer Mode (source on disk, `node_modules` available) for MVP; `.ablx` packaging is post-MVP.

**prolink-connect version:** Requires Node ≥ 20.0.0. The Ableton Extension Host runs Node ≥ 24.14.1, so this is satisfied.
