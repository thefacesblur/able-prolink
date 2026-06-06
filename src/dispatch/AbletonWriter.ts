// src/dispatch/AbletonWriter.ts
import {
  type ExtensionContext,
  type MidiTrack,
  type MidiClip,
  type CuePoint,
} from "@ableton-extensions/sdk";
import type { TrackMeta } from "../prolink/types";
import { arrangementBeat, beatsForDuration, beatsForElapsed } from "../utils/timing";

interface OpenClip {
  clip: MidiClip<"1.0.0">;
  startBeat: number;
  startMs: number;
  isProvisional: boolean;
  name: string;
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
      name,
    });
    console.log(`prolink: clip created — device ${deviceId} "${name}" @ beat ${startBeat.toFixed(2)}`);
  }

  async renameOpenClip(deviceId: number, meta: TrackMeta): Promise<void> {
    const entry = this.openClips.get(deviceId);
    if (!entry?.isProvisional) return;
    const name = `${meta.artist} – ${meta.title}`;
    await this.context.withinTransaction(() => { entry.clip.name = name; });
    entry.isProvisional = false;
    entry.name = name;
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
    await this.context.withinTransaction(() => { newClip.name = entry.name; });
    console.log(`prolink: clip finalized — device ${deviceId} "${entry.name}" duration ${finalDuration.toFixed(2)} beats`);
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
