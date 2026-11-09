import { check, readStlParts, type CheckReport } from "./checks.js";
import { getJob, getModel, supportsOn } from "./jobs.js";
import { meshFor, threemfPieces } from "./mesh.js";
import { ROOT } from "./config.js";
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
  const pieces = src?.endsWith(".3mf") ? threemfPieces(path.join(ROOT, src), job?.object) : 1;
  return { ...check(pos, { supports, part, pieces }), supports };
}
