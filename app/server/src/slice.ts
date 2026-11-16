// Slicing jobs, one run per job and plate size, with progress over SSE. Each slice runs as its
// own process (slice-cli.js, the slicer the terminal uses too): preparing a plate unzips and
// rewrites tens of MB of 3MF, which on the server's thread froze the desktop app's window.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA, ORCA } from "./config.js";
import { publish } from "./events.js";
import { getJob, type Material } from "./jobs.js";
import { getNozzle, STOCK } from "./nozzle.js";

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
      await sliceInChild(job.file, [
        "--per-plate", String(perPlate), "--material", material, "--nozzle", nozzle, ...(oneColor ? ["--one-color"] : []),
      ], (line) => publish("slice", { job: job.name, state: "running", line }));
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

const SLICE_CLI = fileURLToPath(new URL("./slice-cli.js", import.meta.url));

// Slices this server started: stopped with it (the app quitting, or the server shutting down).
const slicers = new Set<ReturnType<typeof spawn>>();
export function stopSlices() { for (const c of slicers) c.kill("SIGTERM"); }
process.once("exit", stopSlices);

/**
 * Run slice-cli.js on this Node (or the desktop app's Electron, run as Node), streaming its
 * progress lines; resolves with the G-code's path.
 */
function sliceInChild(file: string, args: string[], log: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SLICE_CLI, file, ...args], {
      cwd: DATA, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    slicers.add(child);
    let out = "", tail: string[] = [], partial = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => {
      const lines = (partial + c.toString()).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) { log(line); tail = [...tail, line].slice(-8); }
    });
    child.on("error", (e) => reject(new Error(`Couldn't start the slicer: ${e.message}`)));
    child.on("close", (code) => {
      slicers.delete(child);
      if (partial) tail.push(partial);
      if (code === 0) resolve(out.trim().split("\n").pop() ?? "");
      else reject(new Error(tail.join("\n") || `the slicer exited with code ${code}`));
    });
  });
}
