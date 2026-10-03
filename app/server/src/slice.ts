// Slicing stays in scripts/run.py (OrcaSlicer CLI, profiles, filament reassignment).
import { spawn } from "node:child_process";
import { PYTHON, ROOT } from "./config.js";
import { publish } from "./events.js";
import { getJob } from "./jobs.js";

const running = new Map<string, Promise<void>>();

export function isSlicing(job: string) {
  return running.has(job);
}

export function slice(jobName: string): Promise<void> {
  const job = getJob(jobName);
  if (running.has(job.name)) return running.get(job.name)!;

  const work = new Promise<void>((resolve, reject) => {
    publish("slice", { job: job.name, state: "running", line: `Slicing ${job.file}…` });
    const child = spawn(PYTHON, ["-u", "scripts/run.py", job.file, "--slice-only"], { cwd: ROOT });
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
  }).finally(() => running.delete(job.name));

  running.set(job.name, work);
  return work;
}
