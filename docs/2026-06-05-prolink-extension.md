# ProLink Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Ableton Live Extension that listens to Pioneer Pro DJ Link in real-time and creates annotated MIDI deck tracks, on-air clips, cue point markers, and live tempo automation alongside the user's audio recording.

**Architecture:** Single Extension process using `prolink-connect` for Pioneer network integration, an in-memory `EventStore` feeding a `Dispatcher`, which calls an `AbletonWriter` (SDK mutations) and a `ViewBridge` (live status webview via SSE). Context-menu Start/Stop swap dynamically.

**Tech Stack:** TypeScript, Ableton Extensions SDK 1.0.0-beta.0, `prolink-connect`, Node.js built-in `http` (for SSE), `vitest`

---

## File Map

| File | Role |
|---|---|
| `manifest.json` | Extension name updated to `prolink-extension` |
| `package.json` | Add `prolink-connect` dependency |
| `build.ts` | Add `external: ['better-sqlite3']` |
| `src/extension.ts` | `activate()` — wires everything, registers commands + context menus |
| `src/prolink/types.ts` | `ProLinkEvent` union type |
| `src/store/EventStore.ts` | Append-only in-memory log + `flushToDisk()` |
| `src/utils/timing.ts` | `arrangementBeat()` formula + `beatsForDuration()` |
| `src/utils/debounce.ts` | Generic `debounce()` utility |
| `src/dispatch/AbletonWriter.ts` | All Ableton SDK mutations (create tracks/clips/cues, set tempo) |
| `src/dispatch/ViewBridge.ts` | Local SSE HTTP server, opens status webview, receives STOP |
| `src/dispatch/Dispatcher.ts` | Maps `ProLinkEvent` → `AbletonWriter` + `ViewBridge` calls |
| `src/prolink/network.ts` | `bringOnline → autoconfigFromPeers → connect/disconnect` wrapper |
| `src/prolink/listener.ts` | Subscribes to statusEmitter + mixstatus, emits `ProLinkEvent`s |
| `src/commands/startCapture.ts` | Progress dialog, network connect, session init |
| `src/commands/stopCapture.ts` | Disconnect, flush store, close webview |
| `src/ui/statusDialog.html` | Inlined status webview HTML (SSE-connected) |
| `src/__tests__/EventStore.test.ts` | EventStore unit tests |
| `src/__tests__/timing.test.ts` | Timing formula unit tests |
| `src/__tests__/debounce.test.ts` | Debounce utility unit tests |
| `src/__tests__/Dispatcher.test.ts` | Dispatcher unit tests (mocked writer + bridge) |
| `src/__tests__/listener.test.ts` | isOnAir state machine + adjustedBPM unit tests |

---

## Task 1: Project Setup

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `build.ts`
- Delete: all existing `src/` files (replaced in subsequent tasks)

- [ ] **Step 1: Update manifest**

Replace `manifest.json` contents:
```json
{
  "name": "prolink-extension",
  "author": "Adam Graetz",
  "entry": "dist/extension.js",
  "version": "1.0.0",
  "minimumApiVersion": "1.0.0"
}
```

- [ ] **Step 2: Add prolink-connect dependency**

```bash
npm install prolink-connect
```

Expected: `prolink-connect` added to `node_modules` and `package.json` `dependencies`.

- [ ] **Step 3: Mark better-sqlite3 as external in esbuild**

In `build.ts`, add `external` to the options object:
```ts
const options: esbuild.BuildOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  external: ["better-sqlite3"],
};
```

- [ ] **Step 4: Remove old src files**

```bash
rm -rf src/commands src/theory src/storage src/ui src/__tests__ src/extension.ts
```

Then recreate the bare directories:
```bash
mkdir -p src/commands src/prolink src/store src/dispatch src/utils src/ui src/__tests__
```

- [ ] **Step 5: Verify build still works (will fail due to missing extension.ts — that's expected)**

Create a temporary minimal `src/extension.ts`:
```ts
import { type ActivationContext, initialize } from "@ableton-extensions/sdk";
export const activate = (_: ActivationContext) => { initialize(_, "1.0.0"); };
```

Run: `npm run build:dev`
Expected: build succeeds and produces `dist/extension.js`.

- [ ] **Step 6: Commit**

```bash
git add manifest.json package.json package-lock.json build.ts src/extension.ts
git commit -m "chore: bootstrap prolink-extension project"
```

---

## Task 2: ProLink Event Types

**Files:**
- Create: `src/prolink/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/prolink/types.ts
// MediaSlot, TrackType, CueAndLoop are all re-exported from the prolink-connect barrel
import type { MediaSlot, TrackType, CueAndLoop } from "prolink-connect";

export interface TrackMeta {
  title: string;
  artist: string;
  bpm: number;
  durationSecs: number;
  cuePoints: CueAndLoop[];
}

export type ProLinkEvent =
  | { type: "SESSION_START"; timestamp: number; sessionOriginBeat: number }
  | { type: "TRACK_LOADED"; timestamp: number; deviceId: number;
      trackId: number; trackSlot: MediaSlot; trackType: TrackType }
  | { type: "TRACK_METADATA"; timestamp: number; deviceId: number; track: TrackMeta }
  | { type: "ON_AIR_START"; timestamp: number; deviceId: number }
  | { type: "ON_AIR_END"; timestamp: number; deviceId: number }
  | { type: "PITCH_CHANGE"; timestamp: number; deviceId: number;
      trackBPM: number; sliderPitch: number; effectivePitch: number; adjustedBPM: number }
  | { type: "BPM_CHANGE"; timestamp: number; deviceId: number;
      isMasterDevice: boolean; adjustedBPM: number }
  | { type: "LOOP_ENTER"; timestamp: number; deviceId: number }
  | { type: "LOOP_EXIT"; timestamp: number; deviceId: number }
  | { type: "MASTER_CHANGE"; timestamp: number; deviceId: number }
  | { type: "SET_STARTED"; timestamp: number }
  | { type: "SET_ENDED"; timestamp: number }
  | { type: "SESSION_STOP"; timestamp: number };
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/prolink/types.ts
git commit -m "feat: ProLinkEvent union type"
```

---

## Task 3: EventStore

**Files:**
- Create: `src/store/EventStore.ts`
- Create: `src/__tests__/EventStore.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/EventStore.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventStore } from "../store/EventStore";

describe("EventStore", () => {
  it("appends events in order", () => {
    const store = new EventStore();
    store.append({ type: "SESSION_START", timestamp: 1, sessionOriginBeat: 0 });
    store.append({ type: "SESSION_STOP", timestamp: 2 });
    expect(store.getAll().length).toBe(2);
    expect(store.getAll()[0].type).toBe("SESSION_START");
    expect(store.getAll()[1].type).toBe("SESSION_STOP");
  });

  it("getAll returns a frozen copy (cannot push to original)", () => {
    const store = new EventStore();
    store.append({ type: "SESSION_STOP", timestamp: 1 });
    const all = store.getAll();
    expect(() => (all as ProLinkEvent[]).push({ type: "SESSION_STOP", timestamp: 2 })).toThrow();
  });

  it("calls onAppend callback after each append", () => {
    const store = new EventStore();
    const cb = vi.fn();
    store.onAppend(cb);
    store.append({ type: "SET_STARTED", timestamp: 1 });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_STARTED" }));
  });

  it("flushToDisk writes valid JSON with all events", async () => {
    const store = new EventStore();
    store.append({ type: "SESSION_START", timestamp: 100, sessionOriginBeat: 0 });
    store.append({ type: "SESSION_STOP", timestamp: 200 });

    const writtenData: string[] = [];
    const mockWriteFile = vi.fn((_path: string, data: string) => {
      writtenData.push(data);
      return Promise.resolve();
    });

    await store.flushToDisk("/tmp/test.json", mockWriteFile as never);
    expect(mockWriteFile).toHaveBeenCalledWith("/tmp/test.json", expect.any(String));
    const parsed = JSON.parse(writtenData[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].type).toBe("SESSION_START");
  });
});
```

Add missing import at top of test file:
```ts
import type { ProLinkEvent } from "../prolink/types";
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test -- --reporter=verbose EventStore
```
Expected: FAIL (EventStore not yet implemented).

- [ ] **Step 3: Implement EventStore**

```ts
// src/store/EventStore.ts
import type { ProLinkEvent } from "../prolink/types";
import { promises as fs } from "node:fs";

export class EventStore {
  private readonly events: ProLinkEvent[] = [];
  private handler?: (event: ProLinkEvent) => void;

  append(event: ProLinkEvent): void {
    this.events.push(event);
    this.handler?.(event);
  }

  onAppend(handler: (event: ProLinkEvent) => void): void {
    this.handler = handler;
  }

  getAll(): readonly ProLinkEvent[] {
    return Object.freeze([...this.events]);
  }

  async flushToDisk(
    path: string,
    writeFile: typeof fs.writeFile = fs.writeFile,
  ): Promise<void> {
    await writeFile(path, JSON.stringify(this.events, null, 2), "utf8");
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test -- --reporter=verbose EventStore
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/EventStore.ts src/__tests__/EventStore.test.ts
git commit -m "feat: EventStore — append-only event log with flushToDisk"
```

---

## Task 4: Timing & Debounce Utilities

**Files:**
- Create: `src/utils/timing.ts`
- Create: `src/utils/debounce.ts`
- Create: `src/__tests__/timing.test.ts`
- Create: `src/__tests__/debounce.test.ts`

- [ ] **Step 1: Write failing timing tests**

```ts
// src/__tests__/timing.test.ts
import { describe, it, expect } from "vitest";
import { arrangementBeat, beatsForDuration, beatsForElapsed } from "../utils/timing";

describe("arrangementBeat", () => {
  it("returns sessionOriginBeat when event is at capture start", () => {
    expect(arrangementBeat(0, 1000, 1000, 120)).toBe(0);
  });

  it("places event 1 second later at 120 BPM (= 2 beats later)", () => {
    // 1 second at 120 BPM = 120/60 = 2 beats
    expect(arrangementBeat(0, 1000, 2000, 120)).toBeCloseTo(2, 5);
  });

  it("respects non-zero session origin", () => {
    // origin at beat 8, event 2s after start at 120 BPM → beat 8 + 4 = 12
    expect(arrangementBeat(8, 1000, 3000, 120)).toBeCloseTo(12, 5);
  });
});

describe("beatsForDuration", () => {
  it("converts track duration seconds to beats at given BPM", () => {
    // 60 seconds at 120 BPM = 120 beats
    expect(beatsForDuration(60, 120)).toBeCloseTo(120, 5);
  });

  it("uses fallback beats when durationSecs is 0 or falsy", () => {
    expect(beatsForDuration(0, 120)).toBe(16);
  });
});

describe("beatsForElapsed", () => {
  it("converts elapsed wall-clock milliseconds to beats", () => {
    // 1000ms at 120 BPM = 2 beats
    expect(beatsForElapsed(1000, 120)).toBeCloseTo(2, 5);
  });
});
```

- [ ] **Step 2: Write failing debounce tests**

```ts
// src/__tests__/debounce.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../utils/debounce";

describe("debounce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not call fn immediately", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 200);
    debounced(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn after delay with last args", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 200);
    debounced(1);
    debounced(2);
    debounced(3);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("resets timer when called again before delay", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 200);
    debounced(1);
    vi.advanceTimersByTime(100);
    debounced(2);
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run both test files — verify they fail**

```bash
npm test -- --reporter=verbose timing debounce
```
Expected: FAIL (files not yet created).

- [ ] **Step 4: Implement timing utilities**

```ts
// src/utils/timing.ts

const FALLBACK_CLIP_BEATS = 16;

export function arrangementBeat(
  sessionOriginBeat: number,
  captureStartMs: number,
  eventMs: number,
  masterBPM: number,
): number {
  const elapsedSecs = (eventMs - captureStartMs) / 1000;
  return sessionOriginBeat + elapsedSecs * (masterBPM / 60);
}

export function beatsForDuration(durationSecs: number, bpm: number): number {
  if (!durationSecs) return FALLBACK_CLIP_BEATS;
  return durationSecs * (bpm / 60);
}

export function beatsForElapsed(elapsedMs: number, bpm: number): number {
  return (elapsedMs / 1000) * (bpm / 60);
}
```

- [ ] **Step 5: Implement debounce**

```ts
// src/utils/debounce.ts

export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
```

- [ ] **Step 6: Run tests — verify they pass**

```bash
npm test -- --reporter=verbose timing debounce
```
Expected: all 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/utils/timing.ts src/utils/debounce.ts src/__tests__/timing.test.ts src/__tests__/debounce.test.ts
git commit -m "feat: timing formula and debounce utility"
```

---

## Task 5: AbletonWriter

**Files:**
- Create: `src/dispatch/AbletonWriter.ts`

`AbletonWriter` performs all Ableton SDK mutations. It holds the deck tracks and open clip references. No tests here — SDK interactions require a live host; structural correctness is validated by TypeScript.

- [ ] **Step 1: Create AbletonWriter**

```ts
// src/dispatch/AbletonWriter.ts
import {
  type ExtensionContext,
  type MidiTrack,
  type MidiClip,
  type CuePoint,
  Song,
} from "@ableton-extensions/sdk";
import type { TrackMeta } from "../prolink/types";
import { arrangementBeat, beatsForDuration, beatsForElapsed } from "../utils/timing";

interface OpenClip {
  clip: MidiClip<"1.0.0">;
  startBeat: number;
  startMs: number;
  isProvisional: boolean;
}

export class AbletonWriter {
  private deck1Track: MidiTrack<"1.0.0"> | null = null;
  private deck2Track: MidiTrack<"1.0.0"> | null = null;
  private openClips = new Map<number, OpenClip>();
  private sessionOriginBeat = 0;
  private captureStartMs = 0;
  private masterBPM = 120;

  constructor(private readonly context: ExtensionContext<"1.0.0">) {}

  async createDeckTracks(captureStartMs: number, masterBPM: number): Promise<void> {
    this.captureStartMs = captureStartMs;
    this.masterBPM = masterBPM;
    this.sessionOriginBeat = 0; // SDK does not expose song.currentTime in v1.0.0

    const song = this.context.application.song;
    this.deck1Track = await this.context.withinTransaction(() => song.createMidiTrack());
    await this.context.withinTransaction(() => { this.deck1Track!.name = "Deck 1"; });

    this.deck2Track = await this.context.withinTransaction(() => song.createMidiTrack());
    await this.context.withinTransaction(() => { this.deck2Track!.name = "Deck 2"; });
  }

  private trackForDevice(deviceId: number): MidiTrack<"1.0.0"> | null {
    if (deviceId === 1) return this.deck1Track;
    if (deviceId === 2) return this.deck2Track;
    return null;
  }

  private deckLabel(deviceId: number): string {
    return `D${deviceId}`;
  }

  async startOnAirClip(
    deviceId: number,
    eventMs: number,
    meta: TrackMeta | null,
  ): Promise<void> {
    const track = this.trackForDevice(deviceId);
    if (!track) return;

    const startBeat = arrangementBeat(
      this.sessionOriginBeat,
      this.captureStartMs,
      eventMs,
      this.masterBPM,
    );
    const estimatedDuration = meta
      ? beatsForDuration(meta.durationSecs, this.masterBPM)
      : 16;

    const clip = await this.context.withinTransaction(() =>
      track.createMidiClip(startBeat, estimatedDuration),
    );
    const name = meta ? `${meta.artist} – ${meta.title}` : `Deck ${deviceId}`;
    await this.context.withinTransaction(() => { clip.name = name; });

    this.openClips.set(deviceId, {
      clip,
      startBeat,
      startMs: eventMs,
      isProvisional: meta === null,
    });
  }

  async renameOpenClip(deviceId: number, meta: TrackMeta): Promise<void> {
    const entry = this.openClips.get(deviceId);
    if (!entry?.isProvisional) return;
    const name = `${meta.artist} – ${meta.title}`;
    await this.context.withinTransaction(() => { entry.clip.name = name; });
    entry.isProvisional = false;
  }

  async finalizeOnAirClip(deviceId: number, eventMs: number): Promise<void> {
    const entry = this.openClips.get(deviceId);
    if (!entry) return;
    this.openClips.delete(deviceId);

    const track = this.trackForDevice(deviceId);
    if (!track) return;

    const actualBeats = beatsForElapsed(eventMs - entry.startMs, this.masterBPM);
    const finalDuration = Math.max(actualBeats, 0.25);

    await this.context.withinTransaction(() => track.deleteClip(entry.clip));
    const newClip = await this.context.withinTransaction(() =>
      track.createMidiClip(entry.startBeat, finalDuration),
    );
    await this.context.withinTransaction(() => { newClip.name = entry.clip.name; });
  }

  async createOnAirCuePoint(
    deviceId: number,
    eventMs: number,
    meta: TrackMeta | null,
  ): Promise<void> {
    const song = this.context.application.song;
    const beat = arrangementBeat(
      this.sessionOriginBeat,
      this.captureStartMs,
      eventMs,
      this.masterBPM,
    );
    const label = meta
      ? `▶ ${this.deckLabel(deviceId)}: ${meta.artist} – ${meta.title}`
      : `▶ ${this.deckLabel(deviceId)}`;
    const cue = await this.context.withinTransaction(() => song.createCuePoint(beat));
    await this.context.withinTransaction(() => { cue.name = label; });
  }

  async createOffAirCuePoint(deviceId: number, eventMs: number): Promise<void> {
    const song = this.context.application.song;
    const beat = arrangementBeat(
      this.sessionOriginBeat,
      this.captureStartMs,
      eventMs,
      this.masterBPM,
    );
    const cue = await this.context.withinTransaction(() => song.createCuePoint(beat));
    await this.context.withinTransaction(() => {
      cue.name = `■ ${this.deckLabel(deviceId)}`;
    });
  }

  async createLoopCuePoint(deviceId: number, eventMs: number, isEnter: boolean): Promise<void> {
    const song = this.context.application.song;
    const beat = arrangementBeat(
      this.sessionOriginBeat,
      this.captureStartMs,
      eventMs,
      this.masterBPM,
    );
    const label = isEnter
      ? `↺ Loop ${this.deckLabel(deviceId)}`
      : `↺ Loop End ${this.deckLabel(deviceId)}`;
    const cue = await this.context.withinTransaction(() => song.createCuePoint(beat));
    await this.context.withinTransaction(() => { cue.name = label; });
  }

  async createHotCueMarkers(
    deviceId: number,
    onAirStartMs: number,
    meta: TrackMeta,
  ): Promise<void> {
    const song = this.context.application.song;
    const clipStartBeat = arrangementBeat(
      this.sessionOriginBeat,
      this.captureStartMs,
      onAirStartMs,
      this.masterBPM,
    );

    const hotcues = meta.cuePoints.filter((c) => "button" in c);
    if (hotcues.length === 0) return;

    const cues: CuePoint<"1.0.0">[] = await this.context.withinTransaction(() =>
      Promise.all(
        hotcues.map((hc) => {
          const offsetBeats = ((hc as { offset: number }).offset / 1000) * (this.masterBPM / 60);
          return song.createCuePoint(clipStartBeat + offsetBeats);
        }),
      ),
    );

    await this.context.withinTransaction(() => {
      cues.forEach((cue, i) => {
        const button = (hotcues[i] as { button: unknown }).button;
        cue.name = `${this.deckLabel(deviceId)} Hot Cue ${String(button)}`;
      });
    });
  }

  setMasterBPM(bpm: number): void {
    this.masterBPM = bpm;
    this.context.application.song.tempo = bpm;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/dispatch/AbletonWriter.ts
git commit -m "feat: AbletonWriter — all Ableton SDK mutations"
```

---

## Task 6: ViewBridge (SSE Status Server)

**Files:**
- Create: `src/dispatch/ViewBridge.ts`

`ViewBridge` starts a local HTTP server for SSE, opens `showModalDialog` with the status webview, pushes state updates over SSE, and resolves a Promise when the user clicks Stop.

- [ ] **Step 1: Create ViewBridge**

```ts
// src/dispatch/ViewBridge.ts
import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { type ExtensionContext } from "@ableton-extensions/sdk";
import statusDialogHtml from "../ui/statusDialog.html";

export interface DeckState {
  isOnAir: boolean;
  isMaster: boolean;
  title: string;
  artist: string;
  adjustedBPM: number;
}

export interface ViewState {
  sessionMs: number;
  connection: "connecting" | "connected" | "failed";
  decks: Record<number, DeckState>;
}

export class ViewBridge {
  private server: Server | null = null;
  private sseClients: ServerResponse[] = [];
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private captureStartMs = 0;
  private state: ViewState = {
    sessionMs: 0,
    connection: "connecting",
    decks: {},
  };

  constructor(private readonly context: ExtensionContext<"1.0.0">) {}

  async open(captureStartMs: number): Promise<void> {
    this.captureStartMs = captureStartMs;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });

    this.server = createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("retry: 1000\n\n");
        this.sseClients.push(res);
        this.pushToClient(res, this.currentState());
        req.on("close", () => {
          this.sseClients = this.sseClients.filter((c) => c !== res);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (this.server.address() as AddressInfo).port;
    const html = statusDialogHtml.replace("__SSE_PORT__", String(port));

    void this.context.ui
      .showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 480, 320)
      .then((result) => {
        try {
          const msg = JSON.parse(result) as { type: string };
          if (msg.type === "STOP_CAPTURE") this.resolveStop?.();
        } catch {
          this.resolveStop?.();
        }
      })
      .catch(() => this.resolveStop?.());
  }

  waitForStop(): Promise<void> {
    return this.stopPromise ?? Promise.resolve();
  }

  triggerStop(): void {
    this.resolveStop?.();
  }

  pushState(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    const full = this.currentState();
    for (const client of this.sseClients) {
      this.pushToClient(client, full);
    }
  }

  close(): void {
    this.sseClients.forEach((c) => c.end());
    this.sseClients = [];
    this.server?.close();
    this.server = null;
  }

  private currentState(): ViewState {
    return {
      ...this.state,
      sessionMs: Date.now() - this.captureStartMs,
    };
  }

  private pushToClient(client: ServerResponse, data: ViewState): void {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
```

- [ ] **Step 2: Create a placeholder statusDialog.html so TypeScript compiles**

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>ProLink</title></head>
<body><p>Loading…</p></body></html>
```

Save as `src/ui/statusDialog.html`.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dispatch/ViewBridge.ts src/ui/statusDialog.html
git commit -m "feat: ViewBridge — SSE status server and webview lifecycle"
```

---

## Task 7: Dispatcher

**Files:**
- Create: `src/dispatch/Dispatcher.ts`
- Create: `src/__tests__/Dispatcher.test.ts`

The Dispatcher maps `ProLinkEvent`s to `AbletonWriter` and `ViewBridge` calls. It tracks per-deck state (metadata cache, master device, current BPM).

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/Dispatcher.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatch/Dispatcher";
import type { AbletonWriter } from "../dispatch/AbletonWriter";
import type { ViewBridge } from "../dispatch/ViewBridge";

function makeWriter(): AbletonWriter {
  return {
    createDeckTracks: vi.fn().mockResolvedValue(undefined),
    startOnAirClip: vi.fn().mockResolvedValue(undefined),
    renameOpenClip: vi.fn().mockResolvedValue(undefined),
    finalizeOnAirClip: vi.fn().mockResolvedValue(undefined),
    createOnAirCuePoint: vi.fn().mockResolvedValue(undefined),
    createOffAirCuePoint: vi.fn().mockResolvedValue(undefined),
    createLoopCuePoint: vi.fn().mockResolvedValue(undefined),
    createHotCueMarkers: vi.fn().mockResolvedValue(undefined),
    setMasterBPM: vi.fn(),
  } as unknown as AbletonWriter;
}

function makeBridge(): ViewBridge {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    pushState: vi.fn(),
    triggerStop: vi.fn(),
    close: vi.fn(),
    waitForStop: vi.fn().mockResolvedValue(undefined),
  } as unknown as ViewBridge;
}

describe("Dispatcher", () => {
  let writer: AbletonWriter;
  let bridge: ViewBridge;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    writer = makeWriter();
    bridge = makeBridge();
    dispatcher = new Dispatcher(writer, bridge);
  });

  it("SESSION_START calls createDeckTracks and pushes connected state", async () => {
    await dispatcher.handle({
      type: "SESSION_START",
      timestamp: 1000,
      sessionOriginBeat: 0,
    });
    expect(writer.createDeckTracks).toHaveBeenCalledWith(1000, 120);
    expect(bridge.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ connection: "connected" }),
    );
  });

  it("ON_AIR_START calls startOnAirClip and createOnAirCuePoint", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 5000, deviceId: 1 });
    expect(writer.startOnAirClip).toHaveBeenCalledWith(1, 5000, null);
    expect(writer.createOnAirCuePoint).toHaveBeenCalledWith(1, 5000, null);
  });

  it("TRACK_METADATA before ON_AIR_START is cached; used when ON_AIR_START fires", async () => {
    const meta = { title: "Losing It", artist: "Fisher", bpm: 128, durationSecs: 360, cuePoints: [] };
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "TRACK_METADATA", timestamp: 2000, deviceId: 1, track: meta });
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 5000, deviceId: 1 });
    expect(writer.startOnAirClip).toHaveBeenCalledWith(1, 5000, meta);
    expect(writer.createHotCueMarkers).toHaveBeenCalledWith(1, 5000, meta);
  });

  it("TRACK_METADATA after ON_AIR_START calls renameOpenClip", async () => {
    const meta = { title: "Losing It", artist: "Fisher", bpm: 128, durationSecs: 360, cuePoints: [] };
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 5000, deviceId: 1 });
    await dispatcher.handle({ type: "TRACK_METADATA", timestamp: 6000, deviceId: 1, track: meta });
    expect(writer.renameOpenClip).toHaveBeenCalledWith(1, meta);
    expect(writer.createHotCueMarkers).toHaveBeenCalledWith(1, 5000, meta);
  });

  it("ON_AIR_END calls finalizeOnAirClip and createOffAirCuePoint", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 5000, deviceId: 1 });
    await dispatcher.handle({ type: "ON_AIR_END", timestamp: 10000, deviceId: 1 });
    expect(writer.finalizeOnAirClip).toHaveBeenCalledWith(1, 10000);
    expect(writer.createOffAirCuePoint).toHaveBeenCalledWith(1, 10000);
  });

  it("BPM_CHANGE for master device calls setMasterBPM", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({
      type: "BPM_CHANGE",
      timestamp: 1000,
      deviceId: 1,
      isMasterDevice: true,
      adjustedBPM: 128,
    });
    expect(writer.setMasterBPM).toHaveBeenCalledWith(128);
  });

  it("BPM_CHANGE for non-master device does NOT call setMasterBPM", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({
      type: "BPM_CHANGE",
      timestamp: 1000,
      deviceId: 2,
      isMasterDevice: false,
      adjustedBPM: 130,
    });
    expect(writer.setMasterBPM).not.toHaveBeenCalled();
  });

  it("LOOP_ENTER calls createLoopCuePoint with isEnter=true", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "LOOP_ENTER", timestamp: 8000, deviceId: 1 });
    expect(writer.createLoopCuePoint).toHaveBeenCalledWith(1, 8000, true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test -- --reporter=verbose Dispatcher
```
Expected: FAIL (Dispatcher not yet implemented).

- [ ] **Step 3: Implement Dispatcher**

```ts
// src/dispatch/Dispatcher.ts
import type { ProLinkEvent, TrackMeta } from "../prolink/types";
import type { AbletonWriter } from "./AbletonWriter";
import type { ViewBridge, DeckState } from "./ViewBridge";

export class Dispatcher {
  private metaCache = new Map<number, TrackMeta>();
  private onAirStartMs = new Map<number, number>();
  private deckStates = new Map<number, DeckState>();

  constructor(
    private readonly writer: AbletonWriter,
    private readonly bridge: ViewBridge,
  ) {}

  async handle(event: ProLinkEvent): Promise<void> {
    switch (event.type) {
      case "SESSION_START":
        await this.writer.createDeckTracks(event.timestamp, 120);
        this.bridge.pushState({ connection: "connected" });
        break;

      case "TRACK_METADATA": {
        const existing = this.metaCache.get(event.deviceId);
        this.metaCache.set(event.deviceId, event.track);
        const onAirMs = this.onAirStartMs.get(event.deviceId);
        if (onAirMs !== undefined) {
          if (!existing) {
            await this.writer.renameOpenClip(event.deviceId, event.track);
          }
          await this.writer.createHotCueMarkers(event.deviceId, onAirMs, event.track);
        }
        this.updateDeckState(event.deviceId, {
          title: event.track.title,
          artist: event.track.artist,
          adjustedBPM: event.track.bpm,
        });
        break;
      }

      case "ON_AIR_START": {
        const meta = this.metaCache.get(event.deviceId) ?? null;
        this.onAirStartMs.set(event.deviceId, event.timestamp);
        await this.writer.startOnAirClip(event.deviceId, event.timestamp, meta);
        await this.writer.createOnAirCuePoint(event.deviceId, event.timestamp, meta);
        if (meta) {
          await this.writer.createHotCueMarkers(event.deviceId, event.timestamp, meta);
        }
        this.updateDeckState(event.deviceId, { isOnAir: true });
        break;
      }

      case "ON_AIR_END":
        this.onAirStartMs.delete(event.deviceId);
        await this.writer.finalizeOnAirClip(event.deviceId, event.timestamp);
        await this.writer.createOffAirCuePoint(event.deviceId, event.timestamp);
        this.updateDeckState(event.deviceId, { isOnAir: false });
        break;

      case "BPM_CHANGE":
        if (event.isMasterDevice) {
          this.writer.setMasterBPM(event.adjustedBPM);
        }
        this.updateDeckState(event.deviceId, { adjustedBPM: event.adjustedBPM });
        break;

      case "LOOP_ENTER":
        await this.writer.createLoopCuePoint(event.deviceId, event.timestamp, true);
        break;

      case "LOOP_EXIT":
        await this.writer.createLoopCuePoint(event.deviceId, event.timestamp, false);
        break;

      case "MASTER_CHANGE":
        this.updateDeckState(event.deviceId, { isMaster: true });
        for (const [id, state] of this.deckStates) {
          if (id !== event.deviceId) this.updateDeckState(id, { ...state, isMaster: false });
        }
        break;

      case "SESSION_STOP":
        break;
    }
  }

  private updateDeckState(deviceId: number, patch: Partial<DeckState>): void {
    const current = this.deckStates.get(deviceId) ?? {
      isOnAir: false,
      isMaster: false,
      title: "",
      artist: "",
      adjustedBPM: 0,
    };
    const updated = { ...current, ...patch };
    this.deckStates.set(deviceId, updated);
    this.bridge.pushState({
      decks: Object.fromEntries(this.deckStates),
    });
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test -- --reporter=verbose Dispatcher
```
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/Dispatcher.ts src/__tests__/Dispatcher.test.ts
git commit -m "feat: Dispatcher — maps ProLinkEvents to AbletonWriter and ViewBridge"
```

---

## Task 8: NetworkListener

**Files:**
- Create: `src/prolink/network.ts`
- Create: `src/prolink/listener.ts`
- Create: `src/__tests__/listener.test.ts`

The listener subscribes to prolink-connect's status stream and translates state changes into `ProLinkEvent`s. The pure logic (isOnAir debounce, adjustedBPM calculation) is tested in isolation.

- [ ] **Step 1: Write failing listener unit tests**

```ts
// src/__tests__/listener.test.ts
import { describe, it, expect } from "vitest";
import { computeAdjustedBPM, shouldEmitPitchChange } from "../prolink/listener";

describe("computeAdjustedBPM", () => {
  it("returns trackBPM when sliderPitch is 0", () => {
    expect(computeAdjustedBPM(128, 0)).toBeCloseTo(128, 5);
  });

  it("increases BPM for positive pitch", () => {
    expect(computeAdjustedBPM(128, 0.04)).toBeCloseTo(133.12, 2);
  });

  it("decreases BPM for negative pitch", () => {
    expect(computeAdjustedBPM(128, -0.04)).toBeCloseTo(122.88, 2);
  });
});

describe("shouldEmitPitchChange", () => {
  it("returns false when pitch delta is below threshold", () => {
    expect(shouldEmitPitchChange(0.01000, 0.01005)).toBe(false);
  });

  it("returns true when pitch delta exceeds threshold", () => {
    expect(shouldEmitPitchChange(0.0, 0.02)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test -- --reporter=verbose listener
```
Expected: FAIL.

- [ ] **Step 3: Create network.ts**

```ts
// src/prolink/network.ts
import { bringOnline } from "prolink-connect";
import type { ProlinkNetwork } from "prolink-connect";

const AUTOCONFIG_TIMEOUT_MS = 10_000;

export async function connectToNetwork(): Promise<ProlinkNetwork> {
  const network = await bringOnline();

  await Promise.race([
    network.autoconfigFromPeers(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("No Pioneer devices found — check that the XDJ is on the same network")),
        AUTOCONFIG_TIMEOUT_MS,
      ),
    ),
  ]);

  await network.connect();
  return network;
}

export async function disconnectFromNetwork(network: ProlinkNetwork): Promise<void> {
  await network.disconnect();
}
```

- [ ] **Step 4: Create listener.ts with exported pure functions**

```ts
// src/prolink/listener.ts
import type { ProlinkNetwork } from "prolink-connect";
import { CDJStatus } from "prolink-connect";
import type { EventStore } from "../store/EventStore";
import { debounce } from "../utils/debounce";

const PITCH_DELTA_THRESHOLD = 0.001;
const ON_AIR_DEBOUNCE_PACKETS = 1; // require 2 consecutive matching packets before transition

// Pure helpers — exported for testing
export function computeAdjustedBPM(trackBPM: number, sliderPitch: number): number {
  return trackBPM * (1 + sliderPitch);
}

export function shouldEmitPitchChange(prevPitch: number, nextPitch: number): boolean {
  return Math.abs(nextPitch - prevPitch) > PITCH_DELTA_THRESHOLD;
}

interface PlayerWatchState {
  isOnAir: boolean;
  pendingOnAir: boolean | null;
  pendingOnAirCount: number;
  trackId: number;
  sliderPitch: number;
  isMaster: boolean;
  playState: CDJStatus.PlayState;
  trackDeviceId: number;
  trackSlot: number;
  trackType: number;
}

export function attachListener(network: ProlinkNetwork, store: EventStore): () => void {
  const playerState = new Map<number, PlayerWatchState>();

  const emitDebouncedBPM = debounce((deviceId: number, adjustedBPM: number, isMaster: boolean) => {
    store.append({
      type: "BPM_CHANGE",
      timestamp: Date.now(),
      deviceId,
      isMasterDevice: isMaster,
      adjustedBPM,
    });
  }, 200);

  function getOrInit(deviceId: number): PlayerWatchState {
    if (!playerState.has(deviceId)) {
      playerState.set(deviceId, {
        isOnAir: false,
        pendingOnAir: null,
        pendingOnAirCount: 0,
        trackId: 0,
        sliderPitch: 0,
        isMaster: false,
        playState: CDJStatus.PlayState.Empty,
        trackDeviceId: 0,
        trackSlot: 0,
        trackType: 0,
      });
    }
    return playerState.get(deviceId)!;
  }

  function handleStatus(status: CDJStatus.State): void {
    const prev = getOrInit(status.deviceId);
    const now = Date.now();

    // Track load detection
    if (status.trackId !== 0 && status.trackId !== prev.trackId) {
      store.append({
        type: "TRACK_LOADED",
        timestamp: now,
        deviceId: status.deviceId,
        trackId: status.trackId,
        trackSlot: status.trackSlot,
        trackType: status.trackType,
      });
      // Kick off async metadata fetch
      void fetchMetadata(network, store, status);
    }

    // isOnAir debounce: require 2 consecutive packets before firing transition
    if (status.isOnAir !== prev.isOnAir) {
      if (prev.pendingOnAir === status.isOnAir) {
        prev.pendingOnAirCount++;
        if (prev.pendingOnAirCount >= ON_AIR_DEBOUNCE_PACKETS) {
          prev.isOnAir = status.isOnAir;
          prev.pendingOnAir = null;
          prev.pendingOnAirCount = 0;
          store.append({
            type: status.isOnAir ? "ON_AIR_START" : "ON_AIR_END",
            timestamp: now,
            deviceId: status.deviceId,
          });
        }
      } else {
        prev.pendingOnAir = status.isOnAir;
        prev.pendingOnAirCount = 1;
      }
    } else {
      prev.pendingOnAir = null;
      prev.pendingOnAirCount = 0;
    }

    // Master change
    if (status.isMaster && !prev.isMaster) {
      store.append({ type: "MASTER_CHANGE", timestamp: now, deviceId: status.deviceId });
    }

    // BPM / pitch change
    if (status.trackBPM !== null && shouldEmitPitchChange(prev.sliderPitch, status.sliderPitch)) {
      const adjustedBPM = computeAdjustedBPM(status.trackBPM, status.sliderPitch);
      store.append({
        type: "PITCH_CHANGE",
        timestamp: now,
        deviceId: status.deviceId,
        trackBPM: status.trackBPM,
        sliderPitch: status.sliderPitch,
        effectivePitch: status.effectivePitch,
        adjustedBPM,
      });
      emitDebouncedBPM(status.deviceId, adjustedBPM, status.isMaster);
    }

    // Loop state
    const wasLooping = prev.playState === CDJStatus.PlayState.Looping;
    const isLooping = status.playState === CDJStatus.PlayState.Looping;
    if (isLooping && !wasLooping) {
      store.append({ type: "LOOP_ENTER", timestamp: now, deviceId: status.deviceId });
    } else if (!isLooping && wasLooping) {
      store.append({ type: "LOOP_EXIT", timestamp: now, deviceId: status.deviceId });
    }

    // Update stored state
    prev.trackId = status.trackId;
    prev.sliderPitch = status.sliderPitch;
    prev.isMaster = status.isMaster;
    prev.playState = status.playState;
    prev.trackDeviceId = status.trackDeviceId;
    prev.trackSlot = status.trackSlot as number;
    prev.trackType = status.trackType as number;
  }

  network.statusEmitter.on("status", handleStatus);

  network.mixstatus.on("setStarted", () => {
    store.append({ type: "SET_STARTED", timestamp: Date.now() });
  });
  network.mixstatus.on("setEnded", () => {
    store.append({ type: "SET_ENDED", timestamp: Date.now() });
  });

  return () => {
    network.statusEmitter.off("status", handleStatus);
  };
}

async function fetchMetadata(
  network: ProlinkNetwork,
  store: EventStore,
  status: CDJStatus.State,
): Promise<void> {
  try {
    const track = await network.db.getMetadata({
      deviceId: status.trackDeviceId,
      trackType: status.trackType,
      trackSlot: status.trackSlot,
    });
    if (!track) return;
    store.append({
      type: "TRACK_METADATA",
      timestamp: Date.now(),
      deviceId: status.deviceId,
      track: {
        title: track.title ?? "Unknown Title",
        artist: track.artist?.name ?? "Unknown Artist",
        bpm: track.tempo ?? 0,
        durationSecs: track.duration ?? 0,
        cuePoints: track.cueAndLoops ?? [],
      },
    });
  } catch (e) {
    console.warn(`prolink: metadata fetch failed for device ${status.deviceId}:`, e);
  }
}
```

- [ ] **Step 5: Run tests — verify pure helper tests pass**

```bash
npm test -- --reporter=verbose listener
```
Expected: 5 tests PASS.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors. Fix any prolink-connect type import issues (the library exports types from `prolink-connect` and `prolink-connect/lib/types`).

- [ ] **Step 7: Commit**

```bash
git add src/prolink/network.ts src/prolink/listener.ts src/__tests__/listener.test.ts
git commit -m "feat: NetworkListener — prolink-connect integration and isOnAir state machine"
```

---

## Task 9: Status Webview HTML

**Files:**
- Modify: `src/ui/statusDialog.html` (replace placeholder from Task 6)

- [ ] **Step 1: Write the status dialog HTML**

Replace `src/ui/statusDialog.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ProLink Capture</title>
  <style>
    :root {
      --bg: #2C2C2C;
      --panel: #383838;
      --surface: #4E4E4E;
      --accent: #FFA500;
      --text: #FFFFFF;
      --muted: #999999;
      --on-air: #FF4444;
      --border: #1A1A1A;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { font-size: 14px; font-weight: 600; letter-spacing: 0.5px; }
    #timer { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 13px; }
    #connection {
      padding: 6px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    #decks {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px;
      background: var(--border);
    }
    .deck {
      background: var(--panel);
      padding: 14px 16px;
    }
    .deck-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .deck-label { font-weight: 700; font-size: 12px; letter-spacing: 1px; color: var(--muted); }
    .on-air-badge {
      background: var(--on-air);
      color: #fff;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1px;
      padding: 2px 6px;
      border-radius: 2px;
      display: none;
    }
    .on-air-badge.visible { display: inline-block; }
    .track-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .track-artist { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .bpm-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .bpm { font-variant-numeric: tabular-nums; color: var(--accent); }
    .master-badge { font-size: 10px; color: var(--accent); }
    footer {
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: var(--panel);
      display: flex;
      justify-content: flex-end;
    }
    button {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 7px 18px;
      font-size: 13px;
      cursor: pointer;
      border-radius: 3px;
    }
    button:hover { background: #5E5E5E; }
  </style>
</head>
<body>
  <header>
    <h1>ProLink Capture</h1>
    <span id="timer">● 00:00:00</span>
  </header>
  <div id="connection">Connecting…</div>
  <div id="decks">
    <div class="deck" id="deck-1">
      <div class="deck-header">
        <span class="deck-label">DECK 1</span>
        <span class="on-air-badge">ON AIR</span>
      </div>
      <div class="track-title">—</div>
      <div class="track-artist">—</div>
      <div class="bpm-row"><span class="bpm">—</span> BPM <span class="master-badge"></span></div>
    </div>
    <div class="deck" id="deck-2">
      <div class="deck-header">
        <span class="deck-label">DECK 2</span>
        <span class="on-air-badge">ON AIR</span>
      </div>
      <div class="track-title">—</div>
      <div class="track-artist">—</div>
      <div class="bpm-row"><span class="bpm">—</span> BPM <span class="master-badge"></span></div>
    </div>
  </div>
  <footer>
    <button id="stop-btn" onclick="stopCapture()">Stop Capture</button>
  </footer>

  <script>
    const SSE_PORT = __SSE_PORT__;
    const isWebKit = typeof window !== 'undefined' && window.webkit?.messageHandlers?.live;
    const isWebView2 = typeof window !== 'undefined' && window.chrome?.webview;

    function sendMessage(msg) {
      if (isWebKit) {
        window.webkit.messageHandlers.live.postMessage(msg);
      } else if (isWebView2) {
        window.chrome.webview.postMessage(msg);
      }
    }

    function stopCapture() {
      sendMessage({ method: 'close_and_send', params: [JSON.stringify({ type: 'STOP_CAPTURE' })] });
    }

    function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

    function formatMs(ms) {
      const s = ms / 1000;
      return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
    }

    function updateDeck(id, deck) {
      const el = document.getElementById(`deck-${id}`);
      if (!el) return;
      el.querySelector('.on-air-badge').classList.toggle('visible', deck.isOnAir);
      el.querySelector('.track-title').textContent = deck.title || '—';
      el.querySelector('.track-artist').textContent = deck.artist || '—';
      el.querySelector('.bpm').textContent = deck.adjustedBPM ? deck.adjustedBPM.toFixed(1) : '—';
      el.querySelector('.master-badge').textContent = deck.isMaster ? '★' : '';
    }

    const es = new EventSource(`http://127.0.0.1:${SSE_PORT}/events`);
    es.onmessage = (e) => {
      const state = JSON.parse(e.data);
      document.getElementById('timer').textContent = `● ${formatMs(state.sessionMs)}`;
      document.getElementById('connection').textContent =
        state.connection === 'connected' ? `Connected — XDJ (${Object.keys(state.decks).length} players)` :
        state.connection === 'failed' ? 'Connection failed' : 'Connecting…';
      Object.entries(state.decks).forEach(([id, deck]) => updateDeck(id, deck));
    };
    es.onerror = () => {
      document.getElementById('connection').textContent = 'Lost connection to extension';
    };
  </script>
</body>
</html>
```

- [ ] **Step 2: Build and verify no bundling errors**

```bash
npm run build:dev
```
Expected: build succeeds. The HTML is inlined as a text string into `dist/extension.js`.

- [ ] **Step 3: Commit**

```bash
git add src/ui/statusDialog.html
git commit -m "feat: status webview HTML with SSE deck state display"
```

---

## Task 10: Start & Stop Capture Commands

**Files:**
- Create: `src/commands/startCapture.ts`
- Create: `src/commands/stopCapture.ts`

- [ ] **Step 1: Create startCapture.ts**

```ts
// src/commands/startCapture.ts
import type { ExtensionContext } from "@ableton-extensions/sdk";
import { connectToNetwork } from "../prolink/network";
import { attachListener } from "../prolink/listener";
import { EventStore } from "../store/EventStore";
import { Dispatcher } from "../dispatch/Dispatcher";
import { AbletonWriter } from "../dispatch/AbletonWriter";
import { ViewBridge } from "../dispatch/ViewBridge";
import type { ProlinkNetwork } from "prolink-connect";
import { join } from "node:path";

export interface CaptureSession {
  network: ProlinkNetwork;
  store: EventStore;
  bridge: ViewBridge;
  detach: () => void;
}

export async function startCapture(
  context: ExtensionContext<"1.0.0">,
): Promise<CaptureSession | null> {
  let network: ProlinkNetwork | null = null;

  try {
    await context.ui.withinProgressDialog(
      "Connecting to Pioneer network…",
      {},
      async (_update, signal) => {
        if (signal.aborted) return;
        network = await connectToNetwork();
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Connection failed";
    console.error("prolink: startCapture failed:", msg);
    return null;
  }

  if (!network) return null;

  const store = new EventStore();
  const writer = new AbletonWriter(context);
  const bridge = new ViewBridge(context);
  const dispatcher = new Dispatcher(writer, bridge);

  store.onAppend((event) => {
    void dispatcher.handle(event).catch((err) => {
      console.error("prolink: dispatcher error:", err);
    });
  });

  const captureStartMs = Date.now();

  store.append({
    type: "SESSION_START",
    timestamp: captureStartMs,
    sessionOriginBeat: 0,
  });

  const detach = attachListener(network, store);

  await bridge.open(captureStartMs);

  return { network, store, bridge, detach };
}
```

- [ ] **Step 2: Create stopCapture.ts**

```ts
// src/commands/stopCapture.ts
import { disconnectFromNetwork } from "../prolink/network";
import type { CaptureSession } from "./startCapture";
import { join } from "node:path";

export async function stopCapture(
  session: CaptureSession,
  storageDir: string,
): Promise<void> {
  session.detach();

  session.store.append({ type: "SESSION_STOP", timestamp: Date.now() });

  await disconnectFromNetwork(session.network);

  const filename = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const path = join(storageDir, "sessions", filename);

  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(storageDir, "sessions"), { recursive: true });
  await session.store.flushToDisk(path);

  console.log(`prolink: session saved to ${path}`);

  session.bridge.triggerStop();
  session.bridge.close();
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/startCapture.ts src/commands/stopCapture.ts
git commit -m "feat: start/stop capture commands with progress dialog and session flush"
```

---

## Task 11: Extension Wiring

**Files:**
- Modify: `src/extension.ts`

This is the final wiring task: `activate()` registers the Start and Stop context menu actions and swaps them dynamically.

- [ ] **Step 1: Write extension.ts**

`registerContextMenuAction` returns `Promise<() => Promise<void>>` — the unregister function. We store these and call them to swap menus.

```ts
// src/extension.ts
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { startCapture, type CaptureSession } from "./commands/startCapture";
import { stopCapture } from "./commands/stopCapture";

export const activate = (activation: ActivationContext) => {
  const context = initialize(activation, "1.0.0");
  const storageDir = context.environment.storageDirectory ?? ".";

  let activeSession: CaptureSession | null = null;
  // Store unregister functions returned by registerContextMenuAction
  let unregisterStart: Array<() => Promise<void>> = [];
  let unregisterStop: Array<() => Promise<void>> = [];

  const START_ID = "prolink.start-capture";
  const STOP_ID = "prolink.stop-capture";
  const SCOPES = ["AudioTrack", "MidiTrack"] as const;

  context.commands.registerCommand(START_ID, () =>
    void (async () => {
      if (activeSession) {
        console.warn("prolink: capture already running");
        return;
      }
      // Swap context menus: unregister Start, register Stop
      for (const fn of unregisterStart) await fn();
      unregisterStart = [];
      for (const scope of SCOPES) {
        const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Stop Capture", STOP_ID);
        unregisterStop.push(unregFn);
      }

      const session = await startCapture(context);
      if (!session) {
        // Connection failed — swap back to Start
        for (const fn of unregisterStop) await fn();
        unregisterStop = [];
        for (const scope of SCOPES) {
          const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Start Capture", START_ID);
          unregisterStart.push(unregFn);
        }
        return;
      }
      activeSession = session;

      // Wait for user to stop (webview button or Stop context menu command)
      session.bridge.waitForStop().then(async () => {
        if (!activeSession) return;
        await stopCapture(activeSession, storageDir).catch((e) =>
          console.error("prolink: stopCapture error:", e),
        );
        activeSession = null;
        // Swap back to Start
        for (const fn of unregisterStop) await fn();
        unregisterStop = [];
        for (const scope of SCOPES) {
          const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Start Capture", START_ID);
          unregisterStart.push(unregFn);
        }
      }).catch((e) => console.error("prolink: stop handler error:", e));
    })().catch((e) => console.error("prolink: start command error:", e)),
  );

  context.commands.registerCommand(STOP_ID, () =>
    void (async () => {
      if (!activeSession) return;
      activeSession.bridge.triggerStop();
    })().catch((e) => console.error("prolink: stop command error:", e)),
  );

  void (async () => {
    for (const scope of SCOPES) {
      const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Start Capture", START_ID);
      unregisterStart.push(unregFn);
    }
    console.log("prolink-extension loaded");
  })().catch((e) => console.error("prolink: context menu registration failed:", e));
};
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```
Expected: all tests pass (EventStore, timing, debounce, Dispatcher, listener).

- [ ] **Step 3: Build production bundle**

```bash
npm run build
```
Expected: `dist/extension.js` produced with no errors. `better-sqlite3` marked external — no bundling error.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: extension wiring — activate() registers ProLink start/stop commands"
```

---

## Running the Extension

```bash
npm start
```

This builds in dev mode and loads the extension into Live's Extension Host. In Live:
1. Ensure Developer Mode is enabled: Preferences → Extensions → Developer Mode
2. Right-click any MIDI or audio track → "ProLink: Start Capture"
3. The XDJ-RX/XZ must be on the same local network (no Rekordbox running)
4. Status webview opens; deck state updates in real-time
5. Right-click → "ProLink: Stop Capture" or click Stop in the webview
6. Session JSON saved to `<storageDir>/sessions/`
