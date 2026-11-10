// Moonraker client for the K2 (ported from scripts/k2.py).
import fs from "node:fs/promises";
import path from "node:path";
import { MOONRAKER } from "./config.js";
import type { Material } from "./jobs.js";

/** Creality filament ids (Orca's filament_id; the CFS reports them as material_type) that aren't plain PLA. */
const MATERIAL_IDS: Record<string, Material> = { "17001": "wood" }; // CR-Wood

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

async function api(method: string, route: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const res = await fetch(MOONRAKER + route, { method, signal: AbortSignal.timeout(timeoutMs), ...init });
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

const OFFLINE: PrinterStatus = {
  online: false, state: "offline", filename: "", progress: 0, printSeconds: 0, etaSeconds: null,
  layer: { current: null, total: null }, nozzle: { temp: 0, target: 0 }, bed: { temp: 0, target: 0 },
  slots: [], message: "",
};

export async function getStatus(): Promise<PrinterStatus> {
  let s: any;
  try {
    const q = "print_stats&extruder&heater_bed&display_status&virtual_sdcard&box&filament_rack";
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
    slots: slotsFrom(s.box, s.filament_rack),
    message: ps.message ?? "",
  };
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
