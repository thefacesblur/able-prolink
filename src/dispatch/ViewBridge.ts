// src/dispatch/ViewBridge.ts
import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { type ExtensionContext } from "@ableton-extensions/sdk";
import statusDialogHtml from "../ui/statusDialog.html";

export interface DeckState {
  isOnAir: boolean;
  isMaster: boolean;
  title: string;
  artist: string;
  adjustedBPM: number;
}

export interface ViewState {
  sessionMs: number;
  connection: "connecting" | "connected" | "failed";
  decks: Record<number, DeckState>;
}

export class ViewBridge {
  private server: Server | null = null;
  private sseClients: ServerResponse[] = [];
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private captureStartMs = 0;
  private state: ViewState = {
    sessionMs: 0,
    connection: "connecting",
    decks: {},
  };

  constructor(private readonly context: ExtensionContext<"1.0.0">) {}

  async open(captureStartMs: number): Promise<void> {
    this.captureStartMs = captureStartMs;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });

    this.server = createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("retry: 1000\n\n");
        this.sseClients.push(res);
        this.pushToClient(res, this.currentState());
        req.on("close", () => {
          this.sseClients = this.sseClients.filter((c) => c !== res);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
      this.server!.on("error", reject);
    });

    const port = (this.server.address() as AddressInfo).port;
    const html = statusDialogHtml.replace("__SSE_PORT__", String(port));

    void this.context.ui
      .showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 480, 320)
      .then((result) => {
        try {
          const msg = JSON.parse(result) as { type: string };
          if (msg.type === "STOP_CAPTURE") this.resolveStop?.();
        } catch {
          this.resolveStop?.();
        }
      })
      .catch(() => this.resolveStop?.());
  }

  waitForStop(): Promise<void> {
    return this.stopPromise ?? Promise.resolve();
  }

  triggerStop(): void {
    this.resolveStop?.();
  }

  pushState(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    const full = this.currentState();
    for (const client of this.sseClients) {
      this.pushToClient(client, full);
    }
  }

  close(): void {
    this.sseClients.forEach((c) => c.end());
    this.sseClients = [];
    this.server?.close();
    this.server = null;
  }

  private currentState(): ViewState {
    return {
      ...this.state,
      sessionMs: Date.now() - this.captureStartMs,
    };
  }

  private pushToClient(client: ServerResponse, data: ViewState): void {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // client disconnected
    }
  }
}
