// The nozzle on the K2. Klipper's config always says 0.4 and Creality doesn't report a swap,
// so it's set in the app and remembered here; slicing and printing use it (see NOZZLES in scripts/run.py).
import fs from "node:fs";
import path from "node:path";
import { CACHE } from "./config.js";

export const NOZZLES = ["0.4", "0.6"] as const;
export type Nozzle = (typeof NOZZLES)[number];
export const STOCK: Nozzle = "0.4";
/** Profiles a nozzle other than the stock one slices with: its machine profile, and a process overlay. */
export const NOZZLE_PROFILES: Record<Nozzle, string[]> = {
  "0.4": [], // the job's own
  "0.6": ["profiles/k2-machine-0.6.json", "profiles/k2-nozzle-0.6.json"],
};
export const isNozzle = (n: unknown): n is Nozzle => NOZZLES.includes(n as Nozzle);

const FILE = path.join(CACHE, "printer.json");
let current: Nozzle = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8")).nozzle;
    return isNozzle(saved) ? saved : STOCK;
  } catch {
    return STOCK;
  }
})();

export const getNozzle = () => current;

export function setNozzle(n: Nozzle) {
  current = n;
  fs.writeFileSync(FILE, JSON.stringify({ nozzle: n }, null, 2));
}
