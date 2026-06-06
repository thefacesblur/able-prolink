import { disconnectFromNetwork } from "../prolink/network";
import type { CaptureSession } from "./startCapture";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export async function stopCapture(
  session: CaptureSession,
  storageDir: string,
): Promise<void> {
  session.detach();
  session.beatLinkPoller.stop();
  session.beatLinkProcess?.stop();

  session.store.append({ type: "SESSION_STOP", timestamp: Date.now() });

  if (session.network) {
    await disconnectFromNetwork(session.network);
  }

  const filename = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const sessionPath = join(storageDir, "sessions", filename);

  await mkdir(join(storageDir, "sessions"), { recursive: true });
  try {
    await session.store.flushToDisk(sessionPath);
    console.log(`prolink: session saved to ${sessionPath}`);
  } catch (e) {
    console.error(`prolink: failed to save session to ${sessionPath}:`, e);
  }

  session.bridge.triggerStop();
  session.bridge.close();
}
