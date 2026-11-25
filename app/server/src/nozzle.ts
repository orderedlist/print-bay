// The nozzle on each printer. Klipper's config always says 0.4 and Creality doesn't report a swap,
// so it's set in the app and remembered here; slicing and printing use it (see NOZZLE_PROFILES, which slicer.ts swaps in).
import fs from "node:fs";
import path from "node:path";
import { CACHE, K2_HOST, K2_NAME } from "./config.js";

export const NOZZLES = ["0.4", "0.6"] as const;
export type Nozzle = (typeof NOZZLES)[number];
export const STOCK: Nozzle = "0.4";
/** Profiles a nozzle other than the stock one slices with: its machine profile, and a process overlay. */
export const NOZZLE_PROFILES: Record<Nozzle, string[]> = {
  "0.4": [], // the job's own
  "0.6": ["profiles/k2-machine-0.6.json", "profiles/k2-nozzle-0.6.json"],
};
export const isNozzle = (n: unknown): n is Nozzle => NOZZLES.includes(n as Nozzle);

// { printers: { <name or address>: nozzle } }. A file from before there could be several
// printers holds just { nozzle }, which stands for every printer until one is set.
const FILE = path.join(CACHE, "printer.json");
interface Saved { nozzle?: string; printers?: Record<string, string> }
let saved: Saved = (() => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Saved; } catch { return {}; }
})();

export function getNozzle(): Nozzle {
  // by name, or by address if it was set before the printer first answered
  const n = saved.printers ? saved.printers[K2_NAME ?? ""] ?? saved.printers[K2_HOST ?? ""] : saved.nozzle;
  return isNozzle(n) ? n : STOCK;
}

export function setNozzle(n: Nozzle) {
  saved = { printers: { ...saved.printers, [K2_NAME ?? K2_HOST ?? ""]: n } };
  fs.writeFileSync(FILE, JSON.stringify(saved, null, 2));
}
