// The nozzle on each printer. Klipper's config always says 0.4 and Creality doesn't report a swap,
// so it's set in the app and remembered here; slicing and printing use it (see NOZZLE_PROFILES, which slicer.ts swaps in).
import fs from "node:fs";
import path from "node:path";
import { CACHE, PRINTERS } from "./config.js";

export const NOZZLES = ["0.4", "0.6"] as const;
export type Nozzle = (typeof NOZZLES)[number];
export const STOCK: Nozzle = "0.4";
/** Profiles a nozzle other than the stock one slices with: its machine profile, and a process overlay. */
export const NOZZLE_PROFILES: Record<Nozzle, string[]> = {
  "0.4": [], // the job's own
  "0.6": ["profiles/k2-machine-0.6.json", "profiles/k2-nozzle-0.6.json"],
};
export const isNozzle = (n: unknown): n is Nozzle => NOZZLES.includes(n as Nozzle);

// { printers: { <printer id>: nozzle } }: 0.3 kept them by the printer's name (or address), which is
// the id it has here (config.ts savedPrinters). A file from before there could be several printers
// holds just { nozzle }: it was the first printer's.
const FILE = path.join(CACHE, "printer.json");
interface Saved { nozzle?: string; printers?: Record<string, string> }
let saved: Record<string, string> = (() => {
  try {
    const file = JSON.parse(fs.readFileSync(FILE, "utf8")) as Saved;
    return file.printers ?? (file.nozzle && PRINTERS[0] ? { [PRINTERS[0].id]: file.nozzle } : {});
  } catch { return {}; }
})();

/** The nozzle on a printer (by id); the stock one when it's never been set, or for no printer. */
export function getNozzle(printer: string | null | undefined): Nozzle {
  const n = printer ? saved[printer] : undefined;
  return isNozzle(n) ? n : STOCK;
}

export function setNozzle(printer: string, n: Nozzle) {
  saved = { ...saved, [printer]: n };
  fs.writeFileSync(FILE, JSON.stringify({ printers: saved }, null, 2));
}
