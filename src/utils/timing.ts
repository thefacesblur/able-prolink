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
