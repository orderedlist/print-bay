// Renaming and deleting models. A model is its folder (models/<id>) plus the jobs that print it
// (jobs/*.toml whose model is in that folder), their slices (gcode/) and the plates that use them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA, CACHE } from "./config.js";
import { publish } from "./events.js";
import { getModel, listJobs } from "./jobs.js";
import { getQueue, renameJobInQueue } from "./printing.js";
import { isSlicing } from "./slice.js";
import { busyWith, modelRenamed, slugify } from "./agent.js";

const abs = (...p: string[]) => path.join(DATA, ...p);
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** The model's own job files: the ones whose model file is in its folder. */
function jobsOf(id: string) {
  return listJobs().filter((j) => !j.plate && j.model.startsWith(`models/${id}/`));
}

/** Refuse while something is using the model: a queued print, a slice, or Claude. */
function checkIdle(id: string, jobs: string[], doing: string) {
  if (getQueue().entries.some((e) => jobs.includes(e.job))) throw fail(`It's in the print queue: remove it there before you ${doing} it`, 409);
  if (jobs.some((j) => isSlicing(j))) throw fail(`It's being sliced: wait for that before you ${doing} it`, 409);
  if (busyWith(id)) throw fail(`Claude is working on it: wait or stop it before you ${doing} it`, 409);
}

/** Slices of `job`: gcode/<job>.gcode and gcode/<job>-<variant>.gcode, not another job's that starts the same. */
function slicesOf(job: string, others: string[]): string[] {
  const dir = abs("gcode");
  if (!fs.existsSync(dir)) return [];
  const longer = others.filter((o) => o !== job && o.startsWith(`${job}-`));
  return fs.readdirSync(dir).filter((f) => f.endsWith(".gcode") && (f === `${job}.gcode` || f.startsWith(`${job}-`))
    && !longer.some((o) => f === `${o}.gcode` || f.startsWith(`${o}-`)));
}

/** Plate files and the jobs each one lists. */
function plates(): { file: string; text: string }[] {
  const dir = abs("plates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => ({ file: path.join(dir, f), text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A `<job> = <count>` line in a plate's [plate] table. */
const plateLine = (job: string) => new RegExp(`^${esc(job)}\\s*=.*$`, "m");

/**
 * Rename a model: its folder, every path its jobs give, its SOURCE.md title, and the job named
 * after it (with that job's slices and the plates and queue entries that name it).
 */
export function renameModel(id: string, name: string): { id: string } {
  getModel(id);
  const to = slugify(name.trim());
  if (!to) throw fail("Give it a name with some letters or numbers");
  if (to === id) return { id };
  if (fs.existsSync(abs("models", to)) || fs.existsSync(abs("jobs", `${to}.toml`))) throw fail(`There's already a model called ${to}`, 409);
  const all = listJobs().map((j) => j.name);
  const own = jobsOf(id);
  checkIdle(id, own.map((j) => j.name), "rename");

  fs.renameSync(abs("models", id), abs("models", to));
  const renamed: Record<string, string> = {};
  for (const job of own) {
    const file = abs(job.file);
    let text = fs.readFileSync(file, "utf8").replaceAll(`models/${id}/`, `models/${to}/`); // paths and comments
    if (job.name === id) { // the model's main job is named after it: so is the new one
      text = text.replace(/^(name\s*=\s*)"[^"]*"/m, `$1"${to}"`);
      fs.writeFileSync(abs("jobs", `${to}.toml`), text);
      fs.rmSync(file);
      for (const f of slicesOf(id, all)) fs.renameSync(abs("gcode", f), abs("gcode", to + f.slice(id.length)));
      renamed[id] = to;
    } else {
      fs.writeFileSync(file, text);
    }
  }
  for (const [from, into] of Object.entries(renamed)) {
    for (const p of plates()) if (plateLine(from).test(p.text)) fs.writeFileSync(p.file, p.text.replace(plateLine(from), (l) => into + l.slice(from.length)));
    renameJobInQueue(from, into);
  }
  const source = abs("models", to, "SOURCE.md");
  if (fs.existsSync(source)) fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace(/^# .*$/m, `# ${name.trim()}`));
  modelRenamed(id, to, renamed);
  publish("models", null);
  return { id: to };
}

/**
 * Delete a model into the Trash (one folder holding its model folder, job files and plates, laid
 * out as in the library, so it can be put back by hand). Its slices and cached previews go.
 */
export function deleteModel(id: string): { trashed: string } {
  getModel(id);
  const all = listJobs().map((j) => j.name);
  const ownJobs = jobsOf(id);
  const own = ownJobs.map((j) => j.name);
  checkIdle(id, own, "delete");

  const trash = path.join(os.homedir(), ".Trash");
  let dest = path.join(trash, `Print Bay ${id}`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(trash, `Print Bay ${id} ${n}`);
  const move = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.cpSync(abs(rel), path.join(dest, rel), { recursive: true, preserveTimestamps: true });
    fs.rmSync(abs(rel), { recursive: true, force: true });
  };
  move(`models/${id}`);
  for (const job of ownJobs) move(job.file);
  // plates: one made only of this model's parts goes with it; others just lose those lines
  for (const p of plates()) {
    const lines = [...p.text.matchAll(/^([\w.-]+)\s*=\s*\d+\s*$/gm)].map((m) => m[1]);
    if (!lines.length) continue;
    if (lines.every((j) => own.includes(j))) {
      move(path.relative(DATA, p.file));
      const name = p.text.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) for (const f of slicesOf(name, all)) fs.rmSync(abs("gcode", f), { force: true });
    }
    else if (lines.some((j) => own.includes(j))) fs.writeFileSync(p.file, own.reduce((t, j) => t.replace(new RegExp(`${plateLine(j).source}\\n?`, "m"), ""), p.text));
  }
  for (const job of own) for (const f of slicesOf(job, all)) fs.rmSync(abs("gcode", f), { force: true });
  const thumbs = path.join(CACHE, "thumbs");
  if (fs.existsSync(thumbs)) for (const f of fs.readdirSync(thumbs)) if (f.startsWith(`${id}.`)) fs.rmSync(path.join(thumbs, f), { force: true });
  publish("models", null);
  return { trashed: dest };
}
