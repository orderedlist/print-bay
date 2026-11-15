// Slicing jobs, one run per job and plate size, with progress over SSE (the work is in slicer.ts).
import fs from "node:fs";
import { ORCA } from "./config.js";
import { publish } from "./events.js";
import { getJob, type Material } from "./jobs.js";
import { getNozzle, STOCK } from "./nozzle.js";
import { sliceJob } from "./slicer.js";

const running = new Map<string, Promise<void>>();

export function isSlicing(job: string) {
  return [...running.keys()].some((k) => k === job || k.startsWith(`${job}@`));
}

/**
 * `perPlate` > 1 slices that many laid out on one plate (OpenSCAD jobs); `material`, for that
 * spool instead of PLA; `oneColor`, a multi-colour job all on one filament. Always for the nozzle set in the app.
 */
export function slice(jobName: string, perPlate = 1, material: Material = "pla", oneColor = false): Promise<void> {
  const job = getJob(jobName);
  if (!fs.existsSync(ORCA)) throw Object.assign(new Error("OrcaSlicer isn't set up, so nothing can be sliced. Install it or set its path in Settings."), { statusCode: 409 });
  const nozzle = getNozzle();
  const key = `${job.name}${perPlate > 1 ? `@${perPlate}` : ""}${oneColor ? "@1c" : ""}${material === "pla" ? "" : `@${material}`}${nozzle === STOCK ? "" : `@${nozzle}mm`}`;
  if (running.has(key)) return running.get(key)!;

  const work = (async () => {
    publish("slice", { job: job.name, state: "running", line: `Slicing ${job.file}${oneColor ? " in one colour" : ""}${material === "pla" ? "" : ` for ${material}`}${nozzle === STOCK ? "" : ` (${nozzle} mm nozzle)`}…` });
    try {
      await sliceJob(job.file, { perPlate, material, oneColor, nozzle }, (line) => publish("slice", { job: job.name, state: "running", line }));
    } catch (e) {
      publish("slice", { job: job.name, state: "failed", line: (e as Error).message });
      throw new Error(`Slicing ${job.name} failed: ${(e as Error).message}`);
    }
    publish("slice", { job: job.name, state: "done", line: "Sliced." });
    publish("models", null);
  })().finally(() => running.delete(key));

  running.set(key, work);
  return work;
}
