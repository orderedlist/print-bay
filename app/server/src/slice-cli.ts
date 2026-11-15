// node app/server/dist/slice-cli.js <job.toml> [--per-plate N] [--material wood|silk] [--nozzle 0.6] [--one-color] [--path-only]
// Slices a job (or a plate) the way the app does and prints the G-code's path; progress goes to stderr.
// scripts/run.py slices through this (via scripts/slice), so the app and the terminal share one slicer.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./config.js";
import { isMaterial } from "./jobs.js";
import { isNozzle, NOZZLES } from "./nozzle.js";
import { gcodeFor, loadJob, sliceJob, type SliceOptions } from "./slicer.js";

const args = process.argv.slice(2);
const usage = "usage: scripts/slice <job.toml> [--per-plate N] [--material wood|silk] [--nozzle 0.6] [--one-color] [--path-only]";
const opts: SliceOptions = {};
let file: string | null = null;
let pathOnly = false;
try {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => { if (i + 1 >= args.length) throw new Error(`${a} needs a value`); return args[++i]; };
    if (a === "--per-plate") opts.perPlate = Math.max(1, Math.floor(Number(value())));
    else if (a === "--material") { const m = value(); if (!isMaterial(m)) throw new Error(`Unknown material ${m} (pla, wood or silk)`); opts.material = m; }
    else if (a === "--nozzle") { const n = value(); if (!isNozzle(n)) throw new Error(`Unknown nozzle ${n} (${NOZZLES.join(" or ")})`); opts.nozzle = n; }
    else if (a === "--one-color") opts.oneColor = true;
    else if (a === "--path-only") pathOnly = true;
    else if (a.startsWith("-") || file) throw new Error(usage);
    else file = a;
  }
  if (!file) throw new Error(usage);
  // a path from where the command runs, else one inside the library
  const job = fs.existsSync(file) ? path.resolve(file) : path.resolve(DATA, file);
  if (!fs.existsSync(job)) throw new Error(`No job file at ${file} (the library is ${DATA})`);
  const gcode = pathOnly ? gcodeFor(loadJob(job), opts) : await sliceJob(job, opts, (line) => console.error(line));
  console.log(gcode);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
