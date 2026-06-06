import type { ProLinkEvent } from "../prolink/types";
import { promises as fs } from "node:fs";

export class EventStore {
  private readonly events: ProLinkEvent[] = [];
  private handler?: (event: ProLinkEvent) => void;

  append(event: ProLinkEvent): void {
    this.events.push(event);
    this.handler?.(event);
  }

  onAppend(handler: (event: ProLinkEvent) => void): void {
    this.handler = handler;
  }

  getAll(): readonly ProLinkEvent[] {
    return Object.freeze([...this.events]);
  }

  async flushToDisk(
    path: string,
    writeFile: (path: string, data: string) => Promise<void> = (p, d) => fs.writeFile(p, d, "utf8"),
  ): Promise<void> {
    await writeFile(path, JSON.stringify(this.events, null, 2));
  }
}
