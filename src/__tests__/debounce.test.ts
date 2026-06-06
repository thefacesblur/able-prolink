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
