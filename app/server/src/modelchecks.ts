import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CheckReport, Finding } from "./checks.js";
import { DATA } from "./config.js";
import { getJob, getModel, supportsOn, type Job } from "./jobs.js";
import { meshFor, plateLayout, threemfPieces } from "./mesh.js";

// ---- the checks, in a worker and remembered per mesh ----

let worker: Worker | null = null;
const waiting = new Map<number, { resolve: (r: CheckReport) => void; reject: (e: Error) => void }>();
let nextId = 1;

function runInWorker(file: string, supports: boolean, pieces: number): Promise<CheckReport> {
  if (!worker) {
    worker = new Worker(new URL("./check-worker.js", import.meta.url));
    worker.on("message", ({ id, report, error }: { id: number; report?: CheckReport; error?: string }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (!waiting.size) worker?.unref(); // nothing pending: don't keep a CLI process alive
      if (error) w?.reject(new Error(error)); else w?.resolve(report!);
    });
    worker.on("error", (e: Error) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); worker = null; });
  }
  const id = nextId++;
  worker.ref();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ id, file, supports, pieces });
  });
}

const cache = new Map<string, Promise<CheckReport>>();

/** The checks on one mesh file, run once per version of it. */
function checkFile(file: string, supports: boolean, pieces: number): Promise<CheckReport> {
  const key = JSON.stringify([file, fs.statSync(file).mtimeMs, supports, pieces]);
  let hit = cache.get(key);
  if (!hit) {
    hit = runInWorker(file, supports, pieces);
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

/** How many separate shells a job's mesh has on purpose: a 3MF's pieces, plus a fill_base disc. */
function piecesOf(job: Job | null, file: string | null): number {
  return (file?.endsWith(".3mf") ? threemfPieces(path.join(DATA, file), job?.object) : 1) + (job?.fillBase ? 1 : 0);
}

/**
 * Run the printability checks on a model as it will be sliced. A plate is checked part by
 * part (each cached, so changing how many is instant), with each part's findings named and
 * placed on its first copy in the plate view. Orca arranges the plate when it slices, so the
 * view's rows aren't checked as a layout.
 */
export async function checkModel(id: string, jobName?: string): Promise<CheckReport & { supports: boolean }> {
  const model = getModel(id);
  const pick = model.jobs.find((j) => j.name === jobName) ?? model.jobs[0];
  const job = pick ? getJob(pick.name) : null;
  const supports = job ? supportsOn(job) : false;
  if (!job?.plate) {
    const file = await meshFor(id, { print: true, job: job?.name });
    return { ...(await checkFile(file, supports, piecesOf(job, job?.model ?? model.file))), supports };
  }

  const layout = await plateLayout(id, job.plate, true);
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  let top = 0;
  for (const p of layout) for (const [x, y] of p.at) {
    lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y);
    hi[0] = Math.max(hi[0], x + p.hi[0] - p.lo[0]); hi[1] = Math.max(hi[1], y + p.hi[1] - p.lo[1]);
    top = Math.max(top, p.hi[2] - p.lo[2]);
  }
  const middle = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const reports = await Promise.all(layout.map(async (p) => {
    const part = getJob(p.job);
    const label = part.label ?? p.job;
    const r = await checkFile(p.file, supportsOn(part), piecesOf(part, part.model));
    // the part's findings are centred on itself: move them onto its first copy on the plate
    const [x, y] = p.at[0];
    const dx = x + (p.hi[0] - p.lo[0]) / 2 - middle[0], dy = y + (p.hi[1] - p.lo[1]) / 2 - middle[1];
    const findings: Finding[] = r.findings.map((f) => ({ ...f, message: `${label}: ${f.message}`, at: [f.at[0] + dx, f.at[1] + dy, f.at[2]] }));
    return { findings, triangles: r.triangles * p.count };
  }));
  return {
    findings: reports.flatMap((r) => r.findings),
    size: [hi[0] - lo[0], hi[1] - lo[1], top],
    triangles: reports.reduce((n, r) => n + r.triangles, 0),
    supports,
  };
}
