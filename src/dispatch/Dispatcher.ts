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
        this.metaCache.clear();
        this.onAirStartMs.clear();
        this.deckStates.clear();
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
