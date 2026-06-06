# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run typecheck       # TypeScript type check (no emit)
npm run build           # typecheck + production bundle + .ablx package
npm run build:dev       # typecheck + dev bundle (sourcemaps, no minify)
npm run start           # build:dev then load into Ableton via extensions-cli
npm run watch           # build:dev + file watch + extensions-cli run
npm test                # run all vitest tests (node environment)
```

Run a single test file:
```sh
npx vitest run src/__tests__/Dispatcher.test.ts
```

## Architecture

This is an **Ableton Live Extension** (`.ablx`) that captures a live DJ set from Pioneer CDJs/XDJs and writes it into Ableton's arrangement view as MIDI clips and cue points in real time.

### Entry point

`src/extension.ts` — activates the extension, registers two commands (`prolink.start-capture` / `prolink.stop-capture`) and context-menu actions on AudioTrack/MidiTrack. Manages the single `CaptureSession` lifetime.

### Capture session lifecycle (`src/commands/`)

`startCapture` → `stopCapture`. On start: launch Beat Link API JAR if needed → try prolink-connect → create `EventStore`, `AbletonWriter`, `ViewBridge`, `Dispatcher` → open status UI dialog → return `CaptureSession`. On stop: flush events to `sessions/<timestamp>.json` in `storageDirectory`, close the dialog.

### Dual event-source model (`src/prolink/`)

The extension has two Pioneer event sources that run simultaneously:

| Source | File | Mode |
|---|---|---|
| **prolink-connect** | `listener.ts` | Direct UDP; used when Beat Link Trigger is NOT running. Provides on-air, pitch, loop, master-change events + remote DB metadata queries. |
| **Beat Link API poller** | `beatLinkPoller.ts` | HTTP polling (`localhost:17081/params.json`) every 200 ms. Primary source when Beat Link Trigger IS running (it occupies the same UDP ports). Also supplements metadata in prolink-connect mode. |

`beatLinkLauncher.ts` auto-launches the bundled `beat-link-api.jar`. The JAR is vendored at `vendor/beat-link-api.jar`; `build.ts` copies it to `dist/` and packages it into the `.ablx`.

`network.ts` wraps `prolink-connect`'s `bringOnline()` with autoconfig-from-peers (8 s timeout) and manual LAN interface fallback.

### Event pipeline

```
prolink-connect listener  ──┐
                             ├──► EventStore ──► Dispatcher ──► AbletonWriter  (writes to Live)
Beat Link API poller      ──┘                               └──► ViewBridge    (SSE → status dialog)
```

`EventStore` (`src/store/EventStore.ts`) is an append-only in-memory log of `ProLinkEvent` values (see `src/prolink/types.ts`). It serialises to JSON on session stop.

`Dispatcher` (`src/dispatch/Dispatcher.ts`) is stateful: caches track metadata per deck, tracks on-air start timestamps, and routes each event type to the correct `AbletonWriter` and `ViewBridge` calls.

`AbletonWriter` (`src/dispatch/AbletonWriter.ts`) maps wall-clock timestamps to Ableton beat positions using `src/utils/timing.ts`, then calls the Ableton Extensions SDK to create/rename/finalize MIDI clips and cue points.

`ViewBridge` (`src/dispatch/ViewBridge.ts`) runs a local HTTP SSE server (random port) and injects the port into the status dialog HTML. The dialog posts `STOP_CAPTURE` via its close button, which resolves the stop promise.

### Build system

`build.ts` uses esbuild to bundle `src/extension.ts` → `dist/extension.js` (CJS, single file). The Extension Host's sandboxed Node.js blocks `require()` resolution for modules not on disk, so `better-sqlite3` and `iconv-lite` are aliased to empty stubs in `src/stubs/`. The `.html` loader inlines `statusDialog.html` as a string. After bundling, the Beat Link API JAR is copied from dev paths and everything is zipped into `<name>-<version>.ablx`.

`vite.config.ts` serves the standalone `ui/interface.html` at `localhost:5173` for UI development only.

### Key constraints

- The Extension Host runs bundled CJS inside Ableton's Node.js sandbox — no dynamic `require()` resolution, limited filesystem access.
- Ableton SDK calls must go through `context.withinTransaction()` — all property mutations need their own transaction.
- prolink-connect and Beat Link Trigger cannot coexist on the same machine (same UDP ports). The code degrades gracefully to poller-only mode when connect fails.
- `remotedb.get()` holds an internal Mutex with no try/finally; a thrown error deadlocks all future calls for that device. `listener.ts` uses `remotedbPending` to prevent concurrent in-flight calls.
