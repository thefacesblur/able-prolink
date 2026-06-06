import type { ConnectedProlinkNetwork } from "prolink-connect";
import { CDJStatus } from "prolink-connect";
import type { EventStore } from "../store/EventStore";
import { debounce } from "../utils/debounce";

const PITCH_DELTA_THRESHOLD = 0.001;
const ON_AIR_DEBOUNCE_PACKETS = 1;

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
  trackSlot: CDJStatus.State["trackSlot"];
  trackType: CDJStatus.State["trackType"];
}

export function attachListener(network: ConnectedProlinkNetwork, store: EventStore): () => void {
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
        trackSlot: 0 as CDJStatus.State["trackSlot"],
        trackType: 0 as CDJStatus.State["trackType"],
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
      void fetchMetadata(network, store, status);
    }

    // isOnAir debounce: require consecutive packets before firing transition
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
    prev.trackSlot = status.trackSlot;
    prev.trackType = status.trackType;
  }

  const statusEmitter = network.statusEmitter;
  const mixstatus = network.mixstatus;

  if (!statusEmitter) {
    console.error("prolink: statusEmitter is null — network may not be fully connected");
    return () => {};
  }

  statusEmitter.on("status", handleStatus);
  console.log("prolink: statusEmitter listener attached");

  const handleSetStarted = () => {
    store.append({ type: "SET_STARTED", timestamp: Date.now() });
  };
  const handleSetEnded = () => {
    store.append({ type: "SET_ENDED", timestamp: Date.now() });
  };

  mixstatus?.on("setStarted", handleSetStarted);
  mixstatus?.on("setEnded", handleSetEnded);

  return () => {
    statusEmitter.off("status", handleStatus);
    mixstatus?.off("setStarted", handleSetStarted);
    mixstatus?.off("setEnded", handleSetEnded);
  };
}

// Minimum ms after network.connect() before attempting remote DB connections.
// The XDJ-RX needs to see our virtual CDJ's UDP announcements for a few seconds
// before it will accept TCP connections from us.
const REMOTEDB_WARMUP_MS = 4_000;

// Per-device: the ms timestamp when we first saw it, so we can delay the first
// remote DB connection until after the warmup window.
const deviceFirstSeen = new Map<number, number>();

// Per-device: whether a remotedb.get() is currently in-flight. RemoteDatabase.get()
// holds a Mutex but has no try-finally — if connectToDevice() throws, the Mutex is
// never released, deadlocking all subsequent calls for that device. We guard against
// this by skipping fetches while one is already in-flight.
const remotedbPending = new Set<number>();

async function fetchMetadata(
  network: ConnectedProlinkNetwork,
  store: EventStore,
  status: CDJStatus.State,
): Promise<void> {
  // network.db.getMetadata() routes CDJ+RB tracks to the SQLite-download path,
  // which requires better-sqlite3 (unavailable in Extension Host). Instead query
  // the remote DB protocol directly — the same TCP path Beat Link Trigger uses.
  //
  // Query.GetMetadata = 8194, MenuTarget.Main = 1
  const remotedb = (network as any).remotedb;
  if (!remotedb) return;

  const trackDevice = status.trackDeviceId;

  // Track when we first see each device so we can enforce the warmup delay
  if (!deviceFirstSeen.has(trackDevice)) {
    deviceFirstSeen.set(trackDevice, Date.now());
  }
  const msSinceFirstSeen = Date.now() - deviceFirstSeen.get(trackDevice)!;
  if (msSinceFirstSeen < REMOTEDB_WARMUP_MS) {
    const remaining = REMOTEDB_WARMUP_MS - msSinceFirstSeen;
    console.log(`prolink: metadata deferred ${remaining}ms — waiting for XDJ to register virtual CDJ`);
    await new Promise<void>((r) => setTimeout(r, remaining));
  }

  // Mutex-leak guard: skip if a connection attempt for this device is already in-flight
  if (remotedbPending.has(trackDevice)) {
    console.log(`prolink: metadata skipped for device ${trackDevice} — remotedb.get already in-flight`);
    return;
  }

  remotedbPending.add(trackDevice);
  try {
    console.log(`prolink: remotedb.get(${trackDevice}) — trackId=${status.trackId} slot=${status.trackSlot} type=${status.trackType}`);
    const conn = await remotedb.get(trackDevice);
    if (!conn) {
      console.warn(`prolink: remotedb.get(${trackDevice}) returned null`);
      return;
    }

    const track = await conn.query({
      queryDescriptor: { trackSlot: status.trackSlot, trackType: status.trackType, menuTarget: 1 },
      query: 8194,
      args: { trackId: status.trackId },
    });

    if (!track) return;

    const artist = track.artist?.title ?? track.artist?.name ?? "Unknown Artist";
    const title  = track.title ?? "Unknown Title";
    console.log(`prolink: metadata — device ${status.deviceId} "${artist}" – "${title}" @ ${track.tempo ?? 0} BPM`);

    store.append({
      type: "TRACK_METADATA",
      timestamp: Date.now(),
      deviceId: status.deviceId,
      track: {
        title,
        artist,
        bpm: track.tempo ?? 0,
        durationSecs: track.duration ?? 0,
        cuePoints: track.cueAndLoops ?? [],
      },
    });
  } catch (e) {
    console.warn(`prolink: metadata fetch failed for device ${status.deviceId}:`, e instanceof Error ? e.message : String(e));
  } finally {
    remotedbPending.delete(trackDevice);
  }
}
