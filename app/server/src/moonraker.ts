// Moonraker client for the K2 (ported from scripts/k2.py).
import fs from "node:fs/promises";
import path from "node:path";
import { MOONRAKER } from "./config.js";

export interface Slot {
  slot: string;   // T1A..T4D
  tool: number;   // G-code tool index: T1A = 0 ... T4D = 15
  color: string;  // #RRGGBB
  remain: number; // percent
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

async function api(method: string, route: string, init: RequestInit = {}, timeoutMs = 10_000) {
  if (!MOONRAKER) throw Object.assign(new Error("No printer set up yet. Add its address in Settings."), { statusCode: 409 });
  const res = await fetch(MOONRAKER + route, { method, signal: AbortSignal.timeout(timeoutMs), ...init });
  if (!res.ok) throw new Error(`Moonraker ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { result?: unknown };
  return body.result ?? body;
}

function slotsFrom(box: any): Slot[] {
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
      });
    });
  }
  return found;
}

const OFFLINE: PrinterStatus = {
  online: false, state: "offline", filename: "", progress: 0, printSeconds: 0, etaSeconds: null,
  layer: { current: null, total: null }, nozzle: { temp: 0, target: 0 }, bed: { temp: 0, target: 0 },
  slots: [], message: "",
};

export async function getStatus(): Promise<PrinterStatus> {
  let s: any;
  try {
    const q = "print_stats&extruder&heater_bed&display_status&virtual_sdcard&box";
    s = ((await api("GET", `/printer/objects/query?${q}`, {}, 5000)) as any).status;
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
    slots: slotsFrom(s.box),
    message: ps.message ?? "",
  };
}

/** Check an address before saving it: Moonraker's /printer/info answers with the host name and state. */
export async function probe(host: string): Promise<{ hostname: string; state: string; message: string }> {
  try {
    const res = await fetch(`http://${host}/printer/info`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = ((await res.json()) as { result?: any }).result ?? {};
    return { hostname: String(info.hostname ?? host), state: String(info.state ?? "ready"), message: String(info.state_message ?? "").trim() };
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? "no answer" : (e as Error).message;
    throw Object.assign(new Error(`Couldn't reach Moonraker at ${host} (${why}). Check the address and that the printer is on.`), { statusCode: 502 });
  }
}

export async function upload(file: string): Promise<void> {
  const form = new FormData();
  form.append("root", "gcodes");
  form.append("file", new Blob([await fs.readFile(file)]), path.basename(file));
  await api("POST", "/server/files/upload", { body: form }, 300_000);
}

export const start = (filename: string) =>
  api("POST", `/printer/print/start?filename=${encodeURIComponent(filename)}`);
export const pause = () => api("POST", "/printer/print/pause");
export const resume = () => api("POST", "/printer/print/resume");
export const cancel = () => api("POST", "/printer/print/cancel");
