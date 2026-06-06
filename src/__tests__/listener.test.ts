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
