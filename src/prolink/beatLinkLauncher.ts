import { get } from "node:http";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Locations to search for the beat-link-api JAR, in priority order.
// The first entry is the bundled copy (inside the .ablx alongside extension.js).
function candidateJarPaths(): string[] {
  const paths: string[] = [];
  // Bundled copy — added to the .ablx package by build.ts
  try { paths.push(join(__dirname, "beat-link-api.jar")); } catch (_) {}
  // Developer local paths (fallback when running unbundled)
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const dev  = join(home, "development");
  paths.push(join(dev, "beat-link-dashboard", "api-server", "target", "uberjar", "beat-link-api-standalone.jar"));
  paths.push(join(dev, "dj-set-capture",      "api-server", "target", "uberjar", "beat-link-api-standalone.jar"));
  return paths;
}

function isAlreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get("http://localhost:17081/params.json", (res) => {
      res.destroy();
      resolve(res.statusCode !== undefined);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

export interface BeatLinkProcess {
  stop: () => void;
}

export async function launchBeatLinkIfNeeded(): Promise<BeatLinkProcess | null> {
  if (await isAlreadyRunning()) {
    console.log("prolink: Beat Link API already running on port 17081");
    return { stop: () => {} };
  }

  const jarPath = candidateJarPaths().find(p => existsSync(p));
  if (!jarPath) {
    console.warn("prolink: beat-link-api.jar not found — start manually: api-server/start-beat-link-api.bat");
    return null;
  }

  console.log(`prolink: launching Beat Link API from ${jarPath}`);

  let proc: import("node:child_process").ChildProcess | null = null;
  try {
    // Dynamic require so a missing --allow-child-process throws here, not at load time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    proc = spawn("java", ["-jar", jarPath], {
      detached: false,
      stdio:    "ignore",
      windowsHide: true,
    });
    proc.on("error", (e) => console.warn("prolink: beat-link-api process error:", e.message));
    proc.on("exit", (code) => console.log("prolink: beat-link-api exited with code", code));
    console.log("prolink: beat-link-api launched (pid", proc.pid, ")");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`prolink: cannot launch beat-link-api (${msg}) — start manually`);
    return null;
  }

  // Wait up to 15s for the server to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 500));
    if (await isAlreadyRunning()) {
      console.log("prolink: Beat Link API ready");
      return { stop: () => { proc?.kill(); } };
    }
  }

  console.warn("prolink: Beat Link API did not start within 15s");
  proc?.kill();
  return null;
}
