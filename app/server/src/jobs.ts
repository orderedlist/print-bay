// Jobs, models, costs and OpenSCAD parameters (ported from scripts/view.py).
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { execFileSync } from "node:child_process";
import { APP_ROOT, DATA, NURB_PYTHON } from "./config.js";
import { getNozzle, NOZZLE_PROFILES, STOCK, type Nozzle } from "./nozzle.js";

export const COLORS: Record<string, string> = {
  black: "#000000", white: "#FFFFFF", grey: "#808080", gray: "#808080",
  red: "#C12E1F", orange: "#FF6A13", yellow: "#F4D53F", green: "#00AE42",
  blue: "#0A2989", purple: "#5E43B7", pink: "#E4BDD0", brown: "#7C4B00",
};
const MESH_TYPES = [".scad", ".3mf", ".stl"]; // plus nurb parts (.py), named by their job

export interface Job {
  name: string;
  file: string; // jobs/<name>.toml, relative to DATA
  model: string;
  color?: string;
  copies: number;
  profiles: Record<string, string>;
  scad: Record<string, string>;
  /** Multi-colour OpenSCAD jobs: each part renders with -D part="<name>" and prints on filament 1, 2, ... in order. */
  parts: { name: string; color: string }[];
  /** A downloaded 3MF holding several parts: the object this job prints (see slicer.ts). */
  object?: string;
  /** What the model page's part picker calls this job. */
  label?: string;
  /** A solid disc added under the object when slicing, filling a logo pressed into its base (see slicer.ts). */
  fillBase?: { radius: number; height: number };
  /** A plate (plates/<name>.toml): other jobs' parts printed together, each this many times. */
  plate?: { job: string; count: number }[];
}

export const hexFor = (color: string) => COLORS[color.toLowerCase()] ?? (color.startsWith("#") ? color : `#${color}`);

export interface Rates { filament_per_kg: number; printer_watts: number; power_per_kwh: number }
export interface Cost { filament: number; power: number; total: number }
export interface Stats { time: string; seconds: number; grams: number; cost: Cost; slicedAt: number }

/**
 * What a spool is made of, as far as slicing cares: plain PLA uses the job's own filament
 * profile; the others swap in their own (MATERIAL_PROFILES below; slicer.ts swaps them in).
 */
export type Material = "pla" | "wood" | "silk";
export type OtherMaterial = Exclude<Material, "pla">;
export const MATERIAL_PROFILES: Record<OtherMaterial, string> = { wood: "profiles/k2-wood.json", silk: "profiles/k2-silk.json" };
const OTHER_MATERIALS = Object.keys(MATERIAL_PROFILES) as OtherMaterial[];
export const isMaterial = (m: unknown): m is Material => m === "pla" || (typeof m === "string" && m in MATERIAL_PROFILES);

export interface ModelJob {
  name: string;
  file: string;
  color: string | null;
  hex: string | null;
  parts: { name: string; color: string; hex: string }[]; // empty: one colour
  copies: number;
  stats: Stats | null;
  stale: boolean; // model, job or profiles changed since the last slice
  plates: { perPlate: number; stats: Stats | null; stale: boolean }[]; // sliced with several to a plate
  plate: { job: string; count: number }[] | null; // a plate of the model's parts: what's on it
  materials: Record<OtherMaterial, { stats: Stats | null; stale: boolean }>; // sliced for a wood-fill or silk spool
  oneColor: Record<Material, { stats: Stats | null; stale: boolean }> | null; // a multi-colour job sliced for one spool
}

export interface Model {
  id: string;
  file: string | null;
  kind: string | null;
  meshKey: string; // changes whenever the rendered mesh would
  source: string;
  jobs: ModelJob[];
}

const abs = (rel: string) => path.join(DATA, rel);
const mtime = (file: string) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);

/**
 * When a model last changed. An OpenSCAD model or nurb part can read other files from its model's
 * folder (imported SVG art, a shared module), so the newest file there counts: editing only the art
 * still re-renders the mesh and marks slices stale. Notes (.md) and hidden files don't count.
 */
const times = new Map<string, number>(); // for one tick: a model listing asks about the same folders many times
export function modelTime(rel: string): number {
  const id = rel.match(/^models\/([^/]+)\/.+\.(scad|py)$/)?.[1];
  if (!id) return mtime(abs(rel));
  let newest = times.get(id);
  if (newest === undefined) {
    let max = 0;
    const walk = (dir: string): void => { // never enters hidden folders (.git, .venv)
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.endsWith(".md")) { // stat follows a symlinked file to its target
          const s = fs.statSync(p, { throwIfNoEntry: false });
          if (s?.isFile()) max = Math.max(max, s.mtimeMs);
        }
      }
    };
    walk(abs(`models/${id}`));
    newest = max;
    if (!times.size) setImmediate(() => times.clear());
    times.set(id, newest);
  }
  return newest;
}

export function listJobs(): Job[] {
  const jobs = readJobs();
  return [...jobs, ...readPlates(jobs)];
}

function readJobs(): Job[] {
  const dir = abs("jobs");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).sort().map((f) => {
    const data = parse(fs.readFileSync(path.join(dir, f), "utf8")) as any;
    return {
      name: data.name,
      file: `jobs/${f}`,
      model: data.model,
      color: data.color,
      copies: data.copies ?? 1,
      profiles: data.profiles ?? {},
      // parameter overrides: [scad] for OpenSCAD (-D), [params] for nurb parts (keyword arguments)
      scad: Object.fromEntries(Object.entries((String(data.model).endsWith(".py") ? data.params : data.scad) ?? {}).map(([k, v]) => [k, String(v)])),
      parts: Object.entries(data.parts ?? {}).map(([name, color]) => ({ name, color: String(color) })),
      object: data.object,
      label: data.label,
      fillBase: data.fill_base ? { radius: Number(data.fill_base.radius), height: Number(data.fill_base.height) } : undefined,
    };
  });
}

/**
 * Plates (plates/*.toml, sliced by slicer.ts): a job made of other jobs' parts. It takes the
 * first part's model and profiles; one colour prints as that colour, several as parts named
 * by what uses each (filament 1, 2, ... in the order they first appear, as slicer.ts assigns them).
 */
function readPlates(jobs: Job[]): Job[] {
  const dir = abs("plates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).sort().flatMap((f): Job[] => {
    const data = parse(fs.readFileSync(path.join(dir, f), "utf8")) as any;
    const plate = Object.entries(data.plate ?? {}).map(([job, count]) => ({ job, count: Number(count) }));
    const members = plate.filter((p) => p.count > 0).map((p) => ({ ...p, of: jobs.find((j) => j.name === p.job) }));
    const first = members.find((m) => m.of)?.of;
    if (!first) return []; // its parts are gone
    const colors = new Map<string, string[]>();
    for (const m of members) if (m.of) {
      const hex = hexFor(m.of.color ?? "");
      colors.set(hex, [...(colors.get(hex) ?? []), m.of.label ?? m.of.name]);
    }
    return [{
      name: data.name, file: `plates/${f}`, model: first.model, copies: 1, profiles: first.profiles, scad: {},
      label: data.label, plate,
      ...(colors.size > 1
        ? { parts: [...colors].map(([color, names]) => ({ name: names.join(", "), color })) }
        : { parts: [], color: [...colors.keys()][0] }),
    }];
  });
}

/** Write a plate's contents (job name -> count), creating plates/<name>.toml if it's new. */
export function writePlate(name: string, label: string, counts: Record<string, number>) {
  fs.mkdirSync(abs("plates"), { recursive: true });
  const lines = Object.entries(counts).filter(([, n]) => n > 0).map(([job, n]) => `${job} = ${n}`);
  fs.writeFileSync(abs(`plates/${name}.toml`),
    `# A plate of parts, made in Print Bay (see "A plate" in scripts/run.py).\nname  = ${JSON.stringify(name)}\nlabel = ${JSON.stringify(label)}\n\n[plate]\n${lines.join("\n")}\n`);
}

export function getJob(name: string): Job {
  const job = listJobs().find((j) => j.name === name);
  if (!job) throw Object.assign(new Error(`No job named ${name}`), { statusCode: 404 });
  return job;
}

export function rates(): Rates {
  return parse(fs.readFileSync(abs("costs.toml"), "utf8")) as unknown as Rates;
}

export function seconds(duration: string): number {
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  return [...duration.matchAll(/(\d+)([dhms])/g)].reduce((t, [, n, u]) => t + Number(n) * units[u], 0);
}

export function cost(grams: number, secs: number, r = rates()): Cost {
  const filament = (grams / 1000) * r.filament_per_kg;
  const power = (secs / 3600) * (r.printer_watts / 1000) * r.power_per_kwh;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { filament: round(filament), power: round(power), total: round(filament + power) };
}

/**
 * gcode/<job>.gcode, gcode/<job>-x<n>.gcode for n laid out on one plate, then -<material>
 * for a spool that isn't PLA, then -<nozzle>mm for a nozzle that isn't the stock 0.4 (slicer.ts
 * and scripts/slice use this too). The nozzle is the one set in the app unless given.
 */
/** `oneColor`: a multi-colour job sliced all on one filament, for when every part comes from the same spool. */
export const gcodePath = (job: string, perPlate = 1, material: Material = "pla", nozzle: Nozzle = getNozzle(), oneColor = false) =>
  abs(`gcode/${perPlate > 1 ? `${job}-x${perPlate}` : job}${oneColor ? "-1c" : ""}${material === "pla" ? "" : `-${material}`}${nozzle === STOCK ? "" : `-${nozzle}mm`}.gcode`);

export function gcodeStats(job: string, r = rates(), perPlate = 1, material: Material = "pla", oneColor = false): Stats | null {
  const file = gcodePath(job, perPlate, material, getNozzle(), oneColor);
  if (!fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  const len = Math.min(size, 200_000);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const tail = buf.toString("utf8");
  const time = tail.match(/^; estimated printing time \(normal mode\) = (.+)$/m)?.[1]?.trim();
  const grams = tail.match(/^; total filament used \[g\] = ([\d.]+)/m)?.[1];
  if (!time || !grams) return null;
  const secs = seconds(time);
  return { time, seconds: secs, grams: Number(grams), cost: cost(Number(grams), secs, r), slicedAt: mtime(file) };
}

/** Anything the slice depends on that changed after it. */
export function isStale(job: Job, perPlate = 1, material: Material = "pla", oneColor = false): boolean {
  const sliced = mtime(gcodePath(job.name, perPlate, material, getNozzle(), oneColor));
  if (!sliced) return true;
  const profiles = { ...job.profiles, ...(material === "pla" ? {} : { filament: MATERIAL_PROFILES[material] }) };
  const nozzle = getNozzle();
  const parts = (job.plate ?? []).map((p) => listJobs().find((j) => j.name === p.job)).filter((j): j is Job => !!j); // a plate: its parts' jobs and models too
  const t = (p: string) => mtime(abs(p));
  const inputs = [job, ...parts].flatMap((j) => [t(j.file), modelTime(j.model)])
    .concat([...Object.values(profiles), ...NOZZLE_PROFILES[nozzle]].map(t));
  return inputs.some((t) => t > sliced);
}

/** Labelled jobs in natural order ("Plant 2" before "Plant 10"), numbered ones before the rest; unlabelled keep their file order. */
function byLabel(a: Job, b: Job): number {
  if (!a.label || !b.label) return 0;
  const numbered = (l: string) => (/\d/.test(l) ? 0 : 1);
  return numbered(a.label) - numbered(b.label) || a.label.localeCompare(b.label, undefined, { numeric: true });
}

export function listModels(): Model[] {
  const jobs = listJobs();
  const r = rates();
  const dir = abs("models");
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .map((id) => {
      const files = fs.readdirSync(path.join(dir, id)).sort();
      let mesh: string | null = null;
      for (const ext of MESH_TYPES) {
        const hit = files.find((f) => f.endsWith(ext));
        if (hit) { mesh = `models/${id}/${hit}`; break; }
      }
      const modelJobs = jobs.filter((j) => j.model.startsWith(`models/${id}/`)) // the model file may sit deeper (a nurb part in parts/)
        .sort(byLabel); // a multi-part model's picker order; its first job is the default and the thumbnail
      if (modelJobs[0]) mesh = modelJobs[0].model;
      const sourceFile = path.join(dir, id, "SOURCE.md");
      return {
        id,
        file: mesh,
        kind: mesh ? path.extname(mesh).slice(1) : null,
        meshKey: mesh ? `${id}:${modelTime(mesh)}:${JSON.stringify([modelJobs[0]?.scad ?? {}, modelJobs[0]?.parts ?? []])}` : id,
        source: fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, "utf8") : "",
        jobs: modelJobs.map((j) => ({
          name: j.name,
          label: j.label ?? null,
          file: j.file,
          color: j.color ?? null,
          hex: j.parts[0] ? hexFor(j.parts[0].color) : j.color ? hexFor(j.color) : null,
          parts: j.parts.map((p) => ({ ...p, hex: hexFor(p.color) })),
          copies: j.copies,
          stats: gcodeStats(j.name, r),
          stale: isStale(j),
          plates: fs.readdirSync(abs("gcode"))
            .map((f) => f.match(new RegExp(`^${j.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-x(\\d+)\\.gcode$`))?.[1])
            .filter((n): n is string => !!n).map(Number).sort((a, b) => a - b)
            .map((n) => ({ perPlate: n, stats: gcodeStats(j.name, r, n), stale: isStale(j, n) })),
          materials: Object.fromEntries(OTHER_MATERIALS.map((m) => [m, { stats: gcodeStats(j.name, r, 1, m), stale: isStale(j, 1, m) }])) as ModelJob["materials"],
          plate: j.plate ?? null,
          oneColor: j.parts.length > 1
            ? Object.fromEntries((["pla", ...OTHER_MATERIALS] as Material[]).map((m) => [m, { stats: gcodeStats(j.name, r, 1, m, true), stale: isStale(j, 1, m, true) }])) as ModelJob["oneColor"]
            : null,
        })),
      };
    });
}

export function getModel(id: string): Model {
  const model = listModels().find((m) => m.id === id);
  if (!model) throw Object.assign(new Error(`No model named ${id}`), { statusCode: 404 });
  return model;
}

// ---- OpenSCAD parameters ----

export interface ScadParam { name: string; default: string; value: string; comment: string }

// A parameter is a top-level assignment built only from numbers, arithmetic and `in`
// (the files' inch constant); anything referencing other variables is derived.
const ASSIGN = /^([A-Za-z_]\w*)\s*=\s*([^;]+);\s*(?:\/\/\s*(.*))?$/;
const SIMPLE = /^[\d.\s+\-*/()]*(\bin\b[\d.\s+\-*/()]*)*$/;

// nurb parts: the part function's keyword defaults, read by scripts/nurb_part.py (cached by file time)
const NUMBERISH = /^(-?(\d+\.?\d*|\.\d+)|True|False)$/;
const HIDDEN = new Set(["upright", "draft"]); // nurb conventions the app sets itself
const nurbCache = new Map<string, { mtime: number; params: { name: string; default: string; comment: string }[] }>();
function nurbParams(job: Job): ScadParam[] {
  const file = abs(job.model);
  const time = mtime(file);
  let hit = nurbCache.get(file);
  if (!hit || hit.mtime !== time) {
    const out = execFileSync(NURB_PYTHON, [path.join(APP_ROOT, "scripts/nurb_part.py"), file, "--params"], { cwd: DATA, encoding: "utf8", timeout: 60_000 });
    hit = { mtime: time, params: JSON.parse(out) };
    nurbCache.set(file, hit);
  }
  return hit.params.filter((p) => !HIDDEN.has(p.name) && NUMBERISH.test(p.default))
    .map((p) => ({ ...p, value: job.scad[p.name] ?? p.default }));
}

export function scadParams(job: Job): ScadParam[] {
  if (job.model.endsWith(".py")) return nurbParams(job);
  if (!job.model.endsWith(".scad")) return [];
  const src = fs.readFileSync(abs(job.model), "utf8");
  const params: ScadParam[] = [];
  for (const line of src.split("\n")) {
    if (/^\s*(module|function)\b/.test(line)) break;
    const m = line.match(ASSIGN);
    if (!m) continue;
    const [, name, value, comment = ""] = m;
    if (name === "in" || !/\d/.test(value) || !SIMPLE.test(value.trim())) continue;
    params.push({ name, default: value.trim(), value: job.scad[name] ?? value.trim(), comment: comment.trim() });
  }
  return params;
}

/** Rewrite only the job's [scad] table; values equal to the file's defaults are dropped. */
export function setScadParams(job: Job, values: Record<string, string>): void {
  const nurb = job.model.endsWith(".py");
  const table = nurb ? "params" : "scad";
  const known = new Map(scadParams(job).map((p) => [p.name, p]));
  const overrides = Object.entries(values).filter(([k, v]) => {
    const p = known.get(k);
    if (!p) throw Object.assign(new Error(`Unknown parameter ${k}`), { statusCode: 400 });
    if (nurb ? !NUMBERISH.test(v.trim()) : !SIMPLE.test(v.trim()) || !/\d/.test(v))
      throw Object.assign(new Error(nurb ? `${k}: use a number` : `${k}: use a number (or a number * in)`), { statusCode: 400 });
    return v.trim() !== p.default;
  });
  const file = abs(job.file);
  const text = fs.readFileSync(file, "utf8");
  // drop the existing [scad] or [params] section (up to the next table header or EOF)
  let next = text.replace(new RegExp(`\\n*^\\[${table}\\][^\\n]*\\n(?:(?!\\[)[^\\n]*\\n?)*`, "m"), "\n").replace(/\n+$/, "\n");
  if (overrides.length) {
    next += nurb ? "\n[params]               # nurb part overrides, passed as keyword arguments (edited by the app)\n"
      : "\n[scad]                 # OpenSCAD overrides, passed as -D (edited by the app)\n";
    next += overrides.map(([k, v]) => `${k} = ${JSON.stringify(v.trim())}`).join("\n") + "\n";
  }
  fs.writeFileSync(file, next);
}

/** Whether the job's slicer settings turn supports on. */
export function supportsOn(job: Job): boolean {
  const data = parse(fs.readFileSync(abs(job.file), "utf8")) as any;
  return String(data.overrides?.process?.enable_support ?? "0") === "1";
}
