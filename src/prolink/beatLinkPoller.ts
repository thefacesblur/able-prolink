import { get } from "node:http";
import type { EventStore } from "../store/EventStore";

// Polls Beat Link Trigger's /params.json every 200ms.
// When Beat Link is running it occupies the same UDP ports as prolink-connect,
// so this poller is the sole event source in that mode.
//
// Start: api-server/start-beat-link-api.bat (default port 17081)

const BEAT_LINK_URL = "http://localhost:17081/params.json";
const POLL_MS = 200;
const BPM_DELTA = 0.5; // minimum BPM change to emit BPM_CHANGE
// Require N consecutive poll readings before emitting an on-air transition
const ON_AIR_DEBOUNCE = 2;

interface BLTrack {
  id: number;
  title?: string;
  artist?: string;
  "starting-tempo"?: number;
  duration?: number;
}

interface BLPlayer {
  number: number;
  kind?: string;
  track?: BLTrack;
  "is-on-air"?: boolean;
  "is-tempo-master"?: boolean;
  "tempo"?: number;
  "track-bpm"?: number;
  "is-playing"?: boolean;
  "is-looping"?: boolean;
}

interface BLParams {
  players?: Record<string, BLPlayer>;
}

function fetchParams(): Promise<BLParams> {
  return new Promise((resolve, reject) => {
    const req = get(BEAT_LINK_URL, (res) => {
      let raw = "";
      res.on("data", (c: Buffer | string) => { raw += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw) as BLParams); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(1_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

interface PlayerState {
  trackId: number | null;
  isOnAir: boolean;
  isMaster: boolean;
  tempo: number;
  pendingOnAir: boolean | null;
  pendingCount: number;
}

function initState(): PlayerState {
  return { trackId: null, isOnAir: false, isMaster: false, tempo: 0, pendingOnAir: null, pendingCount: 0 };
}

export interface BeatLinkPoller {
  stop: () => void;
}

export function startBeatLinkPoller(store: EventStore): BeatLinkPoller {
  const states = new Map<number, PlayerState>();
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  let setStarted = false;

  async function poll(): Promise<void> {
    if (!running) return;
    try {
      const data = await fetchParams();
      if (!connected) {
        console.log("prolink: Beat Link API connected — full event mode");
        connected = true;
      }

      const players = data.players ?? {};

      for (const [key, player] of Object.entries(players)) {
        if (player.kind !== "players" && player.kind !== undefined) continue;
        const deviceId = parseInt(key, 10);
        if (isNaN(deviceId)) continue;

        if (!states.has(deviceId)) states.set(deviceId, initState());
        const prev = states.get(deviceId)!;
        const now = Date.now();

        const newTrackId   = player.track?.id ?? null;
        const newIsOnAir   = player["is-on-air"]     ?? false;
        const newIsMaster  = player["is-tempo-master"] ?? false;
        const newTempo     = player["tempo"] ?? player["track-bpm"] ?? 0;
        const bpm          = player.track?.["starting-tempo"] ?? newTempo;

        // ── Track change ──────────────────────────────────────────────
        if (newTrackId !== null && newTrackId !== prev.trackId) {
          prev.trackId = newTrackId;
          const title  = player.track?.title  ?? "Unknown Title";
          const artist = player.track?.artist ?? "Unknown Artist";
          console.log(`prolink: beatlink track — player ${deviceId} "${artist}" – "${title}" @ ${bpm} BPM`);
          store.append({
            type: "TRACK_METADATA",
            timestamp: now,
            deviceId,
            track: {
              title,
              artist,
              bpm,
              durationSecs: player.track?.duration ?? 0,
              cuePoints: [],
            },
          });
        }

        // ── On-air transition (debounced) ─────────────────────────────
        if (newIsOnAir !== prev.isOnAir) {
          if (prev.pendingOnAir === newIsOnAir) {
            prev.pendingCount++;
            if (prev.pendingCount >= ON_AIR_DEBOUNCE) {
              prev.isOnAir = newIsOnAir;
              prev.pendingOnAir = null;
              prev.pendingCount = 0;

              if (newIsOnAir && !setStarted) {
                setStarted = true;
                store.append({ type: "SET_STARTED", timestamp: now });
              }

              store.append({
                type: newIsOnAir ? "ON_AIR_START" : "ON_AIR_END",
                timestamp: now,
                deviceId,
              });
            }
          } else {
            prev.pendingOnAir = newIsOnAir;
            prev.pendingCount = 1;
          }
        } else {
          prev.pendingOnAir = null;
          prev.pendingCount = 0;
        }

        // ── Master change ─────────────────────────────────────────────
        if (newIsMaster && !prev.isMaster) {
          store.append({ type: "MASTER_CHANGE", timestamp: now, deviceId });
        }
        prev.isMaster = newIsMaster;

        // ── BPM change ────────────────────────────────────────────────
        if (newTempo > 0 && Math.abs(newTempo - prev.tempo) > BPM_DELTA) {
          prev.tempo = newTempo;
          store.append({
            type: "BPM_CHANGE",
            timestamp: now,
            deviceId,
            isMasterDevice: newIsMaster,
            adjustedBPM: newTempo,
          });
        }
      }
    } catch (_e) {
      if (connected) {
        console.warn("prolink: Beat Link API disconnected");
        connected = false;
      }
    }

    if (running) {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  }

  void poll();

  return {
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
