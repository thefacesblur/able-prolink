import { describe, it, expect, vi } from "vitest";
import type { ProLinkEvent } from "../prolink/types";
import { EventStore } from "../store/EventStore";

describe("EventStore", () => {
  it("appends events in order", () => {
    const store = new EventStore();
    store.append({ type: "SESSION_START", timestamp: 1, sessionOriginBeat: 0 });
    store.append({ type: "SESSION_STOP", timestamp: 2 });
    expect(store.getAll().length).toBe(2);
    expect(store.getAll()[0].type).toBe("SESSION_START");
    expect(store.getAll()[1].type).toBe("SESSION_STOP");
  });

  it("getAll returns a frozen copy (cannot push to original)", () => {
    const store = new EventStore();
    store.append({ type: "SESSION_STOP", timestamp: 1 });
    const all = store.getAll();
    expect(() => (all as ProLinkEvent[]).push({ type: "SESSION_STOP", timestamp: 2 })).toThrow();
  });

  it("calls onAppend callback after each append", () => {
    const store = new EventStore();
    const cb = vi.fn();
    store.onAppend(cb);
    store.append({ type: "SET_STARTED", timestamp: 1 });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_STARTED" }));
  });

  it("flushToDisk writes valid JSON with all events", async () => {
    const store = new EventStore();
    store.append({ type: "SESSION_START", timestamp: 100, sessionOriginBeat: 0 });
    store.append({ type: "SESSION_STOP", timestamp: 200 });

    const writtenData: string[] = [];
    const mockWriteFile = vi.fn((_path: string, data: string) => {
      writtenData.push(data);
      return Promise.resolve();
    });

    await store.flushToDisk("/tmp/test.json", mockWriteFile as never);
    expect(mockWriteFile).toHaveBeenCalledWith("/tmp/test.json", expect.any(String));
    const parsed = JSON.parse(writtenData[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].type).toBe("SESSION_START");
  });
});
