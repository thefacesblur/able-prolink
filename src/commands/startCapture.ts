import type { ExtensionContext } from "@ableton-extensions/sdk";
import { connectToNetwork } from "../prolink/network";
import { attachListener } from "../prolink/listener";
import { startBeatLinkPoller, type BeatLinkPoller } from "../prolink/beatLinkPoller";
import { launchBeatLinkIfNeeded, type BeatLinkProcess } from "../prolink/beatLinkLauncher";
import { EventStore } from "../store/EventStore";
import { Dispatcher } from "../dispatch/Dispatcher";
import { AbletonWriter } from "../dispatch/AbletonWriter";
import { ViewBridge } from "../dispatch/ViewBridge";
import type { ConnectedProlinkNetwork, ProlinkNetwork } from "prolink-connect";

export interface CaptureSession {
  network: ProlinkNetwork | null;
  store: EventStore;
  bridge: ViewBridge;
  detach: () => void;
  beatLinkPoller: BeatLinkPoller;
  beatLinkProcess: BeatLinkProcess | null;
}

export async function startCapture(
  context: ExtensionContext<"1.0.0">,
): Promise<CaptureSession | null> {
  let connectedNetwork: ConnectedProlinkNetwork | null = null;

  // Auto-launch Beat Link API server if not already running.
  // This runs before prolink-connect so the port availability is known.
  const beatLinkProcess = await launchBeatLinkIfNeeded();

  // Try to connect via prolink-connect. This WILL fail if Beat Link Trigger is
  // already running (it occupies the same UDP ports). In that case we fall back
  // to Beat Link API polling for all events — don't abort the session.
  try {
    await context.ui.withinProgressDialog(
      "Connecting to Pioneer network…",
      {},
      async (_update, signal) => {
        if (signal.aborted) return;
        const net = await connectToNetwork();
        if (net.isConnected()) {
          connectedNetwork = net;
        }
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`prolink: prolink-connect unavailable (${msg}) — Beat Link API mode`);
    // Don't return null — the Beat Link poller will supply all events
  }

  const store = new EventStore();
  const writer = new AbletonWriter(context);
  const bridge = new ViewBridge(context);
  const dispatcher = new Dispatcher(writer, bridge);

  let dispatchTail = Promise.resolve();
  store.onAppend((event) => {
    dispatchTail = dispatchTail
      .then(() => dispatcher.handle(event))
      .catch((err) => console.error("prolink: dispatcher error:", err));
  });

  const captureStartMs = Date.now();

  store.append({
    type: "SESSION_START",
    timestamp: captureStartMs,
    sessionOriginBeat: 0,
  });

  // Attach prolink-connect listener only when the network is available
  const detach = connectedNetwork
    ? attachListener(connectedNetwork, store)
    : () => {};

  // Beat Link poller runs in both modes:
  //  - prolink-connect mode: supplements with track metadata
  //  - Beat Link mode: provides ALL events (on-air, BPM, metadata)
  const beatLinkPoller = startBeatLinkPoller(store);

  await bridge.open(captureStartMs);

  return { network: connectedNetwork, store, bridge, detach, beatLinkPoller, beatLinkProcess };
}
