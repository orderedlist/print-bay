import { check, readStlParts, type CheckReport } from "./checks.js";
import { getJob, getModel, supportsOn } from "./jobs.js";
import { meshFor } from "./mesh.js";

/** Run the printability checks on a model as it will be sliced. */
export async function checkModel(id: string): Promise<CheckReport & { supports: boolean }> {
  const model = getModel(id);
  const job = model.jobs[0] ? getJob(model.jobs[0].name) : null;
  const supports = job ? supportsOn(job) : false;
  const file = await meshFor(id, { print: true });
  const { pos, part } = readStlParts(file);
  return { ...check(pos, { supports, part }), supports };
}
