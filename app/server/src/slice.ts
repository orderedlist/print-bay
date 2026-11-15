// Slicing jobs, one run per job and plate size, with progress over SSE (the work is in slicer.ts).
import fs from "node:fs";
import { ORCA } from "./config.js";
import { publish } from "./events.js";
import { getJob } from "./jobs.js";
import { sliceJob } from "./slicer.js";

const running = new Map<string, Promise<void>>();

export function isSlicing(job: string) {
  return [...running.keys()].some((k) => k === job || k.startsWith(`${job}@`));
}

/** `perPlate` > 1 slices that many laid out on one plate (OpenSCAD jobs). */
export function slice(jobName: string, perPlate = 1): Promise<void> {
  const job = getJob(jobName);
  if (!fs.existsSync(ORCA)) throw Object.assign(new Error("OrcaSlicer isn't set up, so nothing can be sliced. Install it or set its path in Settings."), { statusCode: 409 });
  const key = perPlate > 1 ? `${job.name}@${perPlate}` : job.name;
  if (running.has(key)) return running.get(key)!;

  const work = (async () => {
    publish("slice", { job: job.name, state: "running", line: `Slicing ${job.file}…` });
    try {
      await sliceJob(job, perPlate, (line) => publish("slice", { job: job.name, state: "running", line }));
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
