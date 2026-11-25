// Moonraker client for the K2 (ported from scripts/k2.py).
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Material } from "./jobs.js";

/** Creality filament ids (Orca's filament_id; the CFS reports them as material_type) that aren't plain PLA. */
const MATERIAL_IDS: Record<string, Material> = { "17001": "wood", "00002": "silk", "05001": "silk" }; // CR-Wood; Generic PLA-Silk, CR-Silk

/** The spool on the holder outside the CFS (the printer's filament_rack). */
export const OUTSIDE = "EXT";

export interface Slot {
  slot: string;   // T1A..T4D, or OUTSIDE
  tool: number;   // G-code tool index: T1A = 0 ... T4D = 15; -1 for the outside spool, which has none
  color: string;  // #RRGGBB
  remain: number | null; // percent; null where the printer can't tell (the outside spool)
  material: Material; // as set for the slot on the printer
}

export interface PrinterStatus {
  online: boolean;
  state: string; // standby | printing | paused | complete | cancelled | error | offline
  filename: string;
  progress: number; // 0..1
  printSeconds: number;
  etaSeconds: number | null;
  layer: { current: number | null; total: number | null };
  nozzle: { temp: number; target: number };
  bed: { temp: number; target: number };
  slots: Slot[];
  message: string;
}

export const IDLE_STATES = new Set(["standby", "complete", "cancelled", "error"]);

/** `host` is Moonraker's ip:port on one printer. */
async function api(host: string, method: string, route: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const res = await fetch(`http://${host}${route}`, { method, signal: AbortSignal.timeout(timeoutMs), ...init });
  if (!res.ok) throw new Error(`Moonraker ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { result?: unknown };
  return body.result ?? body;
}

const materialOf = (code: unknown): Material => MATERIAL_IDS[String(code ?? "").slice(-5)] ?? "pla";

function slotsFrom(box: any, rack: any): Slot[] {
  const found: Slot[] = [];
  for (let unit = 1; unit <= 4; unit++) {
    const u = box?.[`T${unit}`];
    if (u?.state !== "connect") continue;
    "ABCD".split("").forEach((letter, i) => {
      const color = String(u.color_value?.[i] ?? "-1");
      if (color === "-1") return;
      found.push({
        slot: `T${unit}${letter}`,
        tool: (unit - 1) * 4 + i,
        color: "#" + color.slice(-6).toUpperCase(),
        remain: Number(u.remain_len?.[i] ?? 0),
        material: materialOf(u.material_type?.[i]),
      });
    });
  }
  // the outside spool, as set on the printer's screen (it has no RFID count of what's left)
  const rackColor = String(rack?.color_value ?? "-1");
  if (rack && rackColor !== "-1")
    found.push({ slot: OUTSIDE, tool: -1, color: "#" + rackColor.slice(-6).toUpperCase(), remain: null, material: materialOf(rack.material_type) });
  return found;
}

export const OFFLINE: PrinterStatus = {
  online: false, state: "offline", filename: "", progress: 0, printSeconds: 0, etaSeconds: null,
  layer: { current: null, total: null }, nozzle: { temp: 0, target: 0 }, bed: { temp: 0, target: 0 },
  slots: [], message: "",
};

export async function getStatus(host: string): Promise<PrinterStatus> {
  let s: any;
  try {
    const q = "print_stats&extruder&heater_bed&display_status&virtual_sdcard&box&filament_rack";
    s = ((await api(host, "GET", `/printer/objects/query?${q}`, {}, 5000)) as any).status;
  } catch (e) {
    return { ...OFFLINE, message: (e as Error).message };
  }
  const ps = s.print_stats ?? {};
  const progress = s.display_status?.progress || s.virtual_sdcard?.progress || 0;
  const elapsed = Math.round(ps.print_duration ?? 0);
  return {
    online: true,
    state: ps.state ?? "standby",
    filename: ps.filename ?? "",
    progress,
    printSeconds: elapsed,
    etaSeconds: progress > 0.01 && elapsed ? Math.round(elapsed / progress - elapsed) : null,
    layer: { current: ps.info?.current_layer ?? null, total: ps.info?.total_layer ?? null },
    nozzle: { temp: s.extruder?.temperature ?? 0, target: s.extruder?.target ?? 0 },
    bed: { temp: s.heater_bed?.temperature ?? 0, target: s.heater_bed?.target ?? 0 },
    slots: slotsFrom(s.box, s.filament_rack),
    message: ps.message ?? "",
  };
}

/** Check an address before saving it: Moonraker's /printer/info answers with the host name and state. */
export async function probe(host: string): Promise<{ hostname: string; state: string; message: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`http://${host}/printer/info`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = ((await res.json()) as { result?: any }).result ?? {};
    return { hostname: String(info.hostname ?? host), state: String(info.state ?? "ready"), message: String(info.state_message ?? "").trim() };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    const name = host.split(":")[0];
    // an unknown .local name doesn't fail, the Bonjour lookup just never answers
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || (name.endsWith(".local") && (e as Error).name === "TimeoutError"))
      throw Object.assign(new Error(`Nothing on the network answers to ${name}. If the printer is on, use its IP address instead.`), { statusCode: 502 });
    // a printer that's off takes seconds to come back unreachable; a refusal at once is macOS
    if (code === "EHOSTUNREACH" && process.platform === "darwin" && Date.now() - started < 500)
      throw Object.assign(new Error(LOCAL_NETWORK_BLOCKED), { statusCode: 502 });
    const why = (e as Error).name === "TimeoutError" ? "no answer" : code ?? (e as Error).message;
    throw Object.assign(new Error(`Couldn't reach Moonraker at ${host} (${why}). Check the address and that the printer is on.`), { statusCode: 502 });
  }
}

export async function upload(host: string, file: string): Promise<void> {
  const form = new FormData();
  form.append("root", "gcodes");
  form.append("file", new Blob([await fs.readFile(file)]), path.basename(file));
  await api(host, "POST", "/server/files/upload", { body: form }, 300_000);
}

export const start = (host: string, filename: string) =>
  api(host, "POST", `/printer/print/start?filename=${encodeURIComponent(filename)}`);
export const pause = (host: string) => api(host, "POST", "/printer/print/pause");
export const resume = (host: string) => api(host, "POST", "/printer/print/resume");
export const cancel = (host: string) => api(host, "POST", "/printer/print/cancel");

// ---- finding the printer ----

export interface FoundPrinter {
  host: string; // ip:port, as Settings saves it
  ip: string;
  hostname: string; // what the printer calls itself, e.g. K2-360F
  state: string;
  k2: boolean; // a K2: its name says so, or it has a CFS
  mac: string | null; // its network card: the same whatever address it's given
  slots: Slot[]; // the spools loaded: tells two printers on the same network apart
}

const MOONRAKER_PORT = 7125;

// macOS refuses every connection on the local network, at once, until the app is allowed it
const LOCAL_NETWORK_BLOCKED =
  "macOS is blocking Print Bay from the local network. Turn on Print Bay in System Settings > Privacy & Security > Local Network, then try again.";
const MAX_HOSTS = 1024;

/** The IPv4 addresses on this Mac's local networks (a network bigger than MAX_HOSTS: the block around this Mac). */
function localAddresses(): string[] {
  const toInt = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
  const seen = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const bits = Number(a.cidr?.split("/")[1] ?? 24);
      if (bits > 30) continue; // a VPN tunnel or point-to-point link: nothing to scan
      const span = 2 ** (32 - Math.max(bits, 32 - Math.log2(MAX_HOSTS)));
      const start = Math.floor(toInt(a.address) / span) * span;
      for (let n = start + 1; n < start + span - 1; n++) if (toIp(n) !== a.address) seen.add(toIp(n));
    }
  }
  return [...seen];
}

/** Whether something accepts a connection on the Moonraker port within `ms`; "unreachable" when refused outright. */
function portOpen(ip: string, ms: number): Promise<"open" | "closed" | "unreachable"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port: MOONRAKER_PORT });
    const done = (r: "open" | "closed" | "unreachable") => { socket.destroy(); resolve(r); };
    socket.setTimeout(ms, () => done("closed"));
    socket.once("connect", () => done("open"));
    socket.once("error", (e: NodeJS.ErrnoException) => done(e.code === "EHOSTUNREACH" ? "unreachable" : "closed"));
  });
}

/** What stays the same about a printer when its address changes: its name for itself, and the MAC of the card it's reached on. */
export async function identify(host: string): Promise<{ hostname: string | null; mac: string | null }> {
  const get = async (route: string) => ((await (await fetch(`http://${host}${route}`, { signal: AbortSignal.timeout(3000) })).json()) as any).result;
  const [info, sys] = await Promise.all([get("/printer/info").catch(() => null), get("/machine/system_info").catch(() => null)]);
  const ip = host.split(":")[0];
  const cards = Object.values(sys?.system_info?.network ?? {}) as { mac_address?: string; ip_addresses?: { address: string }[] }[];
  const card = cards.find((c) => c.ip_addresses?.some((a) => a.address === ip)) ?? cards.find((c) => c.mac_address);
  return { hostname: info?.hostname ? String(info.hostname) : null, mac: card?.mac_address ? card.mac_address.toLowerCase() : null };
}

/** The saved printer a found one is: by MAC, else by the name it calls itself. */
export function sameIdentity(saved: { mac?: string; hostname?: string }, found: { mac: string | null; hostname: string }): boolean {
  if (saved.mac && found.mac) return saved.mac === found.mac;
  return !!saved.hostname && saved.hostname === found.hostname;
}

let scanning: Promise<FoundPrinter[]> | null = null;

/** Every Moonraker printer on the local networks, K2s first. One scan at a time; takes a few seconds. */
export function scanForPrinters(): Promise<FoundPrinter[]> {
  scanning ??= (async () => {
    const ips = localAddresses();
    const open: string[] = [];
    let unreachable = 0;
    for (let i = 0; i < ips.length; i += 256) {
      const batch = ips.slice(i, i + 256);
      const hits = await Promise.all(batch.map((ip) => portOpen(ip, 700)));
      open.push(...batch.filter((_, k) => hits[k] === "open"));
      unreachable += hits.filter((h) => h === "unreachable").length;
    }
    // on a real network most addresses just don't answer; every one refused at once is macOS saying no
    if (process.platform === "darwin" && ips.length && unreachable === ips.length)
      throw Object.assign(new Error(LOCAL_NETWORK_BLOCKED), { statusCode: 502 });
    const found = await Promise.all(open.map(async (ip): Promise<FoundPrinter | null> => {
      const host = `${ip}:${MOONRAKER_PORT}`;
      try {
        const info = await probe(host);
        let cfs = false, slots: Slot[] = [];
        try {
          const res = await fetch(`http://${host}/printer/objects/query?box&filament_rack`, { signal: AbortSignal.timeout(2000) });
          const s = ((await res.json()) as any)?.result?.status;
          cfs = !!s?.box;
          slots = slotsFrom(s?.box, s?.filament_rack);
        } catch { /* no CFS, or no answer: still a printer */ }
        const { mac } = await identify(host).catch(() => ({ mac: null }));
        return { host, ip, hostname: info.hostname, state: info.state, k2: /^k2/i.test(info.hostname) || cfs, mac, slots };
      } catch { return null; } // something else on that port
    }));
    return found.filter((f): f is FoundPrinter => !!f).sort((a, b) => Number(b.k2) - Number(a.k2) || a.hostname.localeCompare(b.hostname));
  })().finally(() => { scanning = null; });
  return scanning;
}
