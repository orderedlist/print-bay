// Slicing stays in scripts/run.py (OrcaSlicer CLI, profiles, filament reassignment).
import { spawn } from "node:child_process";
import path from "node:path";
import { APP_ROOT, DATA, PYTHON } from "./config.js";
import { publish } from "./events.js";
import { getJob } from "./jobs.js";

const running = new Map<string, Promise<void>>();

export function isSlicing(job: string) {
  return [...running.keys()].some((k) => k === job || k.startsWith(`${job}@`));
}

/** `perPlate` > 1 slices that many laid out on one plate (OpenSCAD jobs). */
export function slice(jobName: string, perPlate = 1): Promise<void> {
  const job = getJob(jobName);
  const key = perPlate > 1 ? `${job.name}@${perPlate}` : job.name;
  if (running.has(key)) return running.get(key)!;

  const work = new Promise<void>((resolve, reject) => {
    publish("slice", { job: job.name, state: "running", line: `Slicing ${job.file}…` });
    const child = spawn(PYTHON, ["-u", path.join(APP_ROOT, "scripts/run.py"), job.file, "--slice-only", ...(perPlate > 1 ? ["--per-plate", String(perPlate)] : [])], { cwd: DATA });
    let tail = "";
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        tail = (tail + "\n" + line).slice(-4000);
        publish("slice", { job: job.name, state: "running", line });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        publish("slice", { job: job.name, state: "done", line: "Sliced." });
        publish("models", null);
        resolve();
      } else {
        publish("slice", { job: job.name, state: "failed", line: `Slicing failed (exit ${code}).` });
        reject(new Error(`Slicing ${job.name} failed:\n${tail.trim().split("\n").slice(-6).join("\n")}`));
      }
    });
  }).finally(() => running.delete(key));

  running.set(key, work);
  return work;
}
