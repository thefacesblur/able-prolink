# Ableton ProLink Extension

An Ableton Live extension that captures a live DJ set from Pioneer CDJs/XDJs in real time and writes it into Ableton's arrangement view as MIDI clips and cue points.

**Press Record. Perform your set. Open Ableton. The entire performance appears as an editable timeline.**

## What it captures

- Track loads with artist/title metadata
- On-air transitions (clip start/end in arrangement)
- Hot cue triggers → arrangement cue points
- Loop enter/exit → cue points
- BPM changes → Ableton tempo
- Master deck changes
- Session start/stop

## Requirements

- Ableton Live with Extensions support
- Pioneer CDJ/XDJ gear on the same LAN
- Node.js ≥ 24.14.1
- Java (for Beat Link API auto-launch)

## Installation

Build the `.ablx` package and load it into Ableton:

```sh
npm install
npm run build
```

This produces `prolink-extension-1.0.0.ablx`. Load it via Ableton's Extensions panel.

> **Beat Link API JAR**: The build copies `beat-link-api-standalone.jar` from `~/development/beat-link-dashboard/api-server/target/uberjar/` or `~/development/dj-set-capture/api-server/target/uberjar/` into the bundle. If neither path exists, the auto-launch feature is unavailable and the JAR must be started manually before capture.

## Usage

1. Connect Pioneer gear to the same network as your machine.
2. In Ableton, right-click any Audio or MIDI track → **ProLink: Start Capture**.
3. A status dialog opens showing deck state and connection status.
4. Perform your set. Two MIDI tracks ("Deck 1", "Deck 2") are created in the arrangement, clips are placed as each track goes on-air, and cue points mark transitions and hot cues.
5. Click **Stop** in the dialog (or right-click → **ProLink: Stop Capture**) when done.

The session is also saved as JSON to Ableton's extension storage directory under `sessions/`.

## Development

```sh
npm run build:dev   # dev bundle with sourcemaps (no .ablx zip)
npm run start       # build:dev + load into Ableton via extensions-cli
npm run watch       # build:dev + file watch + extensions-cli run
npm run typecheck   # TypeScript type check only
npm test            # run all tests
npx vitest run src/__tests__/Dispatcher.test.ts   # single test file
```

The Ableton Extensions CLI (`@ableton-extensions/cli`) and SDK (`@ableton-extensions/sdk`) are vendored locally in `vendor/` as `.tgz` files.

## Architecture

### Dual event-source model

The extension has two Pioneer event sources that run simultaneously during capture:

| Source | When primary |
|---|---|
| **prolink-connect** (direct UDP) | Beat Link Trigger is NOT running |
| **Beat Link API poller** (HTTP, 200 ms) | Beat Link Trigger IS running (occupies the same UDP ports) |

Both sources feed the same `EventStore`. The poller always runs; prolink-connect is skipped (with a warning) if it fails to bind.

### Event pipeline

```
prolink-connect listener  ──┐
                             ├──► EventStore ──► Dispatcher ──► AbletonWriter  (writes to Live)
Beat Link API poller      ──┘                               └──► ViewBridge    (SSE → status dialog)
```

- **`EventStore`** — append-only in-memory log of `ProLinkEvent` values; flushes to JSON on stop.
- **`Dispatcher`** — stateful router; caches track metadata per deck and maps each event type to the correct writer/bridge calls.
- **`AbletonWriter`** — converts wall-clock timestamps to Ableton beat positions, then creates/renames/finalizes MIDI clips and cue points via the Extensions SDK.
- **`ViewBridge`** — runs a local SSE HTTP server (random port), injects the port into the status dialog HTML, and resolves the stop promise when the dialog closes.

### Timing model

All timestamps are wall-clock milliseconds (`Date.now()`). `src/utils/timing.ts` converts them to Ableton beats using the master BPM at capture start. Beat position updates as the master BPM changes.

### Extension Host constraints

- The bundle is CJS (esbuild) — the Extension Host's sandboxed Node.js blocks dynamic `require()` resolution, so `better-sqlite3` and `iconv-lite` are aliased to empty stubs.
- All Ableton SDK property mutations must go inside `context.withinTransaction()`.
- `remotedb.get()` (prolink-connect metadata path) holds an internal mutex with no try/finally; the code uses a `remotedbPending` set to prevent concurrent in-flight calls per device, which would otherwise deadlock.
