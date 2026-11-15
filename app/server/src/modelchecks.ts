import { check, readStlParts, type CheckReport } from "./checks.js";
import { getJob, getModel, supportsOn } from "./jobs.js";
import { meshFor, threemfPieces } from "./mesh.js";
import { DATA } from "./config.js";
import path from "node:path";

/** Run the printability checks on a model as it will be sliced. */
export async function checkModel(id: string, jobName?: string): Promise<CheckReport & { supports: boolean }> {
  const model = getModel(id);
  const pick = model.jobs.find((j) => j.name === jobName) ?? model.jobs[0];
  const job = pick ? getJob(pick.name) : null;
  const supports = job ? supportsOn(job) : false;
  const file = await meshFor(id, { print: true, job: job?.name });
  const { pos, part } = readStlParts(file);
  const src = job?.model ?? model.file;
  // a fill_base disc is its own shell in the mesh (the slicer unions it with the part)
  const pieces = job?.plate // a plate: each part, plus its fill_base disc
    ? job.plate.reduce((n, p) => n + p.count * (getJob(p.job).fillBase ? 2 : 1), 0)
    : (src?.endsWith(".3mf") ? threemfPieces(path.join(DATA, src), job?.object) : 1) + (job?.fillBase ? 1 : 0);
  return { ...check(pos, { supports, part, pieces }), supports };
}
