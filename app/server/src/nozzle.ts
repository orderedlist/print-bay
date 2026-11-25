// The nozzle on each printer. Klipper's config always says 0.4 and Creality doesn't report a swap,
// so it's set in the app and remembered here; slicing and printing use it (see NOZZLE_PROFILES, which slicer.ts swaps in).
import fs from "node:fs";
import path from "node:path";
import { CACHE, isThisPrinter, PRINTER_ID } from "./config.js";

export const NOZZLES = ["0.4", "0.6"] as const;
export type Nozzle = (typeof NOZZLES)[number];
export const STOCK: Nozzle = "0.4";
/** Profiles a nozzle other than the stock one slices with: its machine profile, and a process overlay. */
export const NOZZLE_PROFILES: Record<Nozzle, string[]> = {
  "0.4": [], // the job's own
  "0.6": ["profiles/k2-machine-0.6.json", "profiles/k2-nozzle-0.6.json"],
};
export const isNozzle = (n: unknown): n is Nozzle => NOZZLES.includes(n as Nozzle);

// { printers: { <printer id>: nozzle } } (PRINTER_ID). A file from before there could be several
// printers holds just { nozzle }: it becomes the setting of the printer in use.
const FILE = path.join(CACHE, "printer.json");
interface Saved { nozzle?: string; printers?: Record<string, string> }
let saved: Record<string, string> = (() => {
  try {
    const file = JSON.parse(fs.readFileSync(FILE, "utf8")) as Saved;
    return file.printers ?? (file.nozzle && PRINTER_ID ? { [PRINTER_ID]: file.nozzle } : {});
  } catch { return {}; }
})();

export function getNozzle(): Nozzle {
  const n = Object.entries(saved).find(([id]) => isThisPrinter(id))?.[1];
  return isNozzle(n) ? n : STOCK;
}

export function setNozzle(n: Nozzle) {
  if (!PRINTER_ID) throw Object.assign(new Error("Set up a printer first, in Settings."), { statusCode: 409 });
  saved = { ...Object.fromEntries(Object.entries(saved).filter(([id]) => !isThisPrinter(id))), [PRINTER_ID]: n };
  fs.writeFileSync(FILE, JSON.stringify({ printers: saved }, null, 2));
}
