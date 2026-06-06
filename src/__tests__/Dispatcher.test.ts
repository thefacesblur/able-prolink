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

  it("LOOP_EXIT calls createLoopCuePoint with isEnter=false", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    await dispatcher.handle({ type: "LOOP_EXIT", timestamp: 12000, deviceId: 2 });
    expect(writer.createLoopCuePoint).toHaveBeenCalledWith(2, 12000, false);
  });

  it("MASTER_CHANGE sets isMaster true for that deck and false for others", async () => {
    await dispatcher.handle({ type: "SESSION_START", timestamp: 0, sessionOriginBeat: 0 });
    // Put deck 1 on air first so deckStates has two entries
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 1000, deviceId: 1 });
    await dispatcher.handle({ type: "ON_AIR_START", timestamp: 2000, deviceId: 2 });
    await dispatcher.handle({ type: "MASTER_CHANGE", timestamp: 3000, deviceId: 2 });
    // Last pushState call should have deck 2 as master, deck 1 not
    const calls = (bridge.pushState as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as { decks: Record<number, { isMaster: boolean }> };
    expect(lastCall.decks[2]?.isMaster).toBe(true);
    expect(lastCall.decks[1]?.isMaster).toBe(false);
  });
});
