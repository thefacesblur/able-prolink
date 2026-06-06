import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { startCapture, type CaptureSession } from "./commands/startCapture";
import { stopCapture } from "./commands/stopCapture";

export const activate = (activation: ActivationContext) => {
  const context = initialize(activation, "1.0.0");
  const storageDir = context.environment.storageDirectory ?? ".";

  let activeSession: CaptureSession | null = null;
  let unregisterStart: Array<() => Promise<void>> = [];
  let unregisterStop: Array<() => Promise<void>> = [];

  const START_ID = "prolink.start-capture";
  const STOP_ID = "prolink.stop-capture";
  const SCOPES = ["AudioTrack", "MidiTrack"] as const;

  context.commands.registerCommand(START_ID, () =>
    void (async () => {
      if (activeSession) {
        console.warn("prolink: capture already running");
        return;
      }

      const session = await startCapture(context);
      if (!session) return;

      activeSession = session;

      // Swap menus now that capture is confirmed running
      for (const fn of unregisterStart) await fn();
      unregisterStart = [];
      for (const scope of SCOPES) {
        const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Stop Capture", STOP_ID);
        unregisterStop.push(unregFn);
      }

      session.bridge.waitForStop().then(async () => {
        if (!activeSession) return;
        await stopCapture(activeSession, storageDir).catch((e) =>
          console.error("prolink: stopCapture error:", e),
        );
        activeSession = null;
        for (const fn of unregisterStop) await fn();
        unregisterStop = [];
        for (const scope of SCOPES) {
          const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Start Capture", START_ID);
          unregisterStart.push(unregFn);
        }
      }).catch((e) => console.error("prolink: stop handler error:", e));
    })().catch((e) => console.error("prolink: start command error:", e)),
  );

  context.commands.registerCommand(STOP_ID, () =>
    void (async () => {
      if (!activeSession) return;
      activeSession.bridge.triggerStop();
    })().catch((e) => console.error("prolink: stop command error:", e)),
  );

  void (async () => {
    for (const scope of SCOPES) {
      const unregFn = await context.ui.registerContextMenuAction(scope, "ProLink: Start Capture", START_ID);
      unregisterStart.push(unregFn);
    }
    console.log("prolink-extension loaded");
  })().catch((e) => console.error("prolink: context menu registration failed:", e));
};
