import { networkInterfaces } from "node:os";
import { bringOnline } from "prolink-connect";
import type { ProlinkNetwork } from "prolink-connect";

// RFC 1918 private address ranges — these are real LAN interfaces
const PRIVATE_RANGES = [
  { prefix: "192.168.", bits: 16 },
  { prefix: "10.",      bits: 8  },
  { prefix: "172.",     bits: 12 }, // 172.16–31.x.x checked below
];

function isPrivateIP(addr: string): boolean {
  if (addr.startsWith("192.168.") || addr.startsWith("10.")) return true;
  if (addr.startsWith("172.")) {
    const second = parseInt(addr.split(".")[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

// Pick the best interface: prefer private LAN addresses over VPN/virtual adapters
function getBestInterface() {
  const ifaces = networkInterfaces();
  const candidates: Array<{ address: string; netmask: string; mac: string; internal: boolean; family: string; cidr: string | null }> = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      console.log(`prolink: interface ${name}: ${addr.address} (${isPrivateIP(addr.address) ? "LAN" : "non-LAN"})`);
      candidates.push(addr as typeof candidates[0]);
    }
  }

  // Prefer private/LAN addresses, then fall back to anything
  return candidates.find((a) => isPrivateIP(a.address)) ?? candidates[0] ?? null;
}

export async function connectToNetwork(): Promise<ProlinkNetwork> {
  console.log("prolink: bringOnline starting");
  const network = await bringOnline();
  console.log("prolink: bringOnline done");

  // Try autoconfigFromPeers first — it picks the correct interface by detecting the XDJ's broadcast.
  // Time out after 8s and fall back to manual selection if the XDJ isn't broadcasting yet.
  let configured = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      network.autoconfigFromPeers().then(() => {
        configured = true;
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        console.log("prolink: autoconfigFromPeers succeeded, isConfigured:", network.isConfigured);
      }),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.log("prolink: autoconfigFromPeers timed out — falling back to manual configure");
          resolve();
        }, 8_000);
      }),
    ]);
  } catch (e) {
    console.log("prolink: autoconfigFromPeers threw:", e instanceof Error ? e.message : String(e));
  }

  if (!configured) {
    const iface = getBestInterface();
    if (!iface) {
      await network.disconnect().catch(() => {});
      throw new Error("No network interface found — check your network connection");
    }
    if (!isPrivateIP(iface.address)) {
      console.warn(`prolink: WARNING — best interface is ${iface.address} which may not be your LAN. Check that your PC is connected to the same network as the XDJ.`);
    }
    console.log("prolink: manually configuring with interface", iface.address, "vcdjId=5");
    network.configure({ iface: iface as never, vcdjId: 5 });
  }

  console.log("prolink: calling connect(), isConfigured:", network.isConfigured);
  try {
    network.connect();
    console.log("prolink: connect() succeeded, isConnected:", network.isConnected());
  } catch (e) {
    console.error("prolink: connect() threw:", e instanceof Error ? e.message : String(e));
    await network.disconnect().catch(() => {});
    throw new Error(`Failed to start Pioneer network: ${e instanceof Error ? e.message : String(e)}`);
  }

  return network;
}

export async function disconnectFromNetwork(network: ProlinkNetwork): Promise<void> {
  await network.disconnect().catch(() => {});
}
