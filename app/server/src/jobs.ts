// Jobs, models, costs and OpenSCAD parameters (ported from scripts/view.py).
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { ROOT } from "./config.js";

export const COLORS: Record<string, string> = {
  black: "#000000", white: "#FFFFFF", grey: "#808080", gray: "#808080",
  red: "#C12E1F", orange: "#FF6A13", yellow: "#F4D53F", green: "#00AE42",
  blue: "#0A2989", purple: "#5E43B7", pink: "#E4BDD0", brown: "#7C4B00",
};
const MESH_TYPES = [".scad", ".3mf", ".stl"];

export interface Job {
  name: string;
  file: string; // jobs/<name>.toml, relative to ROOT
  model: string;
  color?: string;
  copies: number;
  profiles: Record<string, string>;
  scad: Record<string, string>;
  /** Multi-colour OpenSCAD jobs: each part renders with -D part="<name>" and prints on filament 1, 2, ... in order. */
  parts: { name: string; color: string }[];
}

export const hexFor = (color: string) => COLORS[color.toLowerCase()] ?? (color.startsWith("#") ? color : `#${color}`);

export interface Rates { filament_per_kg: number; printer_watts: number; power_per_kwh: number }
export interface Cost { filament: number; power: number; total: number }
export interface Stats { time: string; seconds: number; grams: number; cost: Cost; slicedAt: number }

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
}

export interface Model {
  id: string;
  file: string | null;
  kind: string | null;
  meshKey: string; // changes whenever the rendered mesh would
  source: string;
  jobs: ModelJob[];
}

const abs = (rel: string) => path.join(ROOT, rel);
const mtime = (file: string) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);

export function listJobs(): Job[] {
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
      scad: Object.fromEntries(Object.entries(data.scad ?? {}).map(([k, v]) => [k, String(v)])),
      parts: Object.entries(data.parts ?? {}).map(([name, color]) => ({ name, color: String(color) })),
    };
  });
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

/** gcode/<job>.gcode, or gcode/<job>-x<n>.gcode for n laid out on one plate (see scripts/run.py). */
export const gcodePath = (job: string, perPlate = 1) => abs(`gcode/${perPlate > 1 ? `${job}-x${perPlate}` : job}.gcode`);

export function gcodeStats(job: string, r = rates(), perPlate = 1): Stats | null {
  const file = gcodePath(job, perPlate);
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
export function isStale(job: Job, perPlate = 1): boolean {
  const sliced = mtime(gcodePath(job.name, perPlate));
  if (!sliced) return true;
  const inputs = [job.model, job.file, ...Object.values(job.profiles)].map((p) => mtime(abs(p)));
  return inputs.some((t) => t > sliced);
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
      const modelJobs = jobs.filter((j) => path.dirname(j.model) === `models/${id}`);
      if (modelJobs[0]) mesh = modelJobs[0].model;
      const sourceFile = path.join(dir, id, "SOURCE.md");
      return {
        id,
        file: mesh,
        kind: mesh ? path.extname(mesh).slice(1) : null,
        meshKey: mesh ? `${id}:${mtime(abs(mesh))}:${JSON.stringify([modelJobs[0]?.scad ?? {}, modelJobs[0]?.parts ?? []])}` : id,
        source: fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, "utf8") : "",
        jobs: modelJobs.map((j) => ({
          name: j.name,
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

export function scadParams(job: Job): ScadParam[] {
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
  const known = new Map(scadParams(job).map((p) => [p.name, p]));
  const overrides = Object.entries(values).filter(([k, v]) => {
    const p = known.get(k);
    if (!p) throw Object.assign(new Error(`Unknown parameter ${k}`), { statusCode: 400 });
    if (!SIMPLE.test(v.trim()) || !/\d/.test(v)) throw Object.assign(new Error(`${k}: use a number (or a number * in)`), { statusCode: 400 });
    return v.trim() !== p.default;
  });
  const file = abs(job.file);
  const text = fs.readFileSync(file, "utf8");
  // drop the existing [scad] section (up to the next table header or EOF)
  let next = text.replace(/\n*^\[scad\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m, "\n").replace(/\n+$/, "\n");
  if (overrides.length) {
    next += "\n[scad]                 # OpenSCAD overrides, passed as -D (edited by the app)\n";
    next += overrides.map(([k, v]) => `${k} = ${JSON.stringify(v.trim())}`).join("\n") + "\n";
  }
  fs.writeFileSync(file, next);
}

/** Whether the job's slicer settings turn supports on. */
export function supportsOn(job: Job): boolean {
  const data = parse(fs.readFileSync(abs(job.file), "utf8")) as any;
  return String(data.overrides?.process?.enable_support ?? "0") === "1";
}
