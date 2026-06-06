import { describe, it, expect } from "vitest";
import { arrangementBeat, beatsForDuration, beatsForElapsed } from "../utils/timing";

describe("arrangementBeat", () => {
  it("returns sessionOriginBeat when event is at capture start", () => {
    expect(arrangementBeat(0, 1000, 1000, 120)).toBe(0);
  });

  it("places event 1 second later at 120 BPM (= 2 beats later)", () => {
    expect(arrangementBeat(0, 1000, 2000, 120)).toBeCloseTo(2, 5);
  });

  it("respects non-zero session origin", () => {
    expect(arrangementBeat(8, 1000, 3000, 120)).toBeCloseTo(12, 5);
  });
});

describe("beatsForDuration", () => {
  it("converts track duration seconds to beats at given BPM", () => {
    expect(beatsForDuration(60, 120)).toBeCloseTo(120, 5);
  });

  it("uses fallback beats when durationSecs is 0 or falsy", () => {
    expect(beatsForDuration(0, 120)).toBe(16);
  });
});

describe("beatsForElapsed", () => {
  it("converts elapsed wall-clock milliseconds to beats", () => {
    expect(beatsForElapsed(1000, 120)).toBeCloseTo(2, 5);
  });
});
