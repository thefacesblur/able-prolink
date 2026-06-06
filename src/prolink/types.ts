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
