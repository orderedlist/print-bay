// Slicing with OrcaSlicer's CLI (ported from scripts/run.py's slice_job, so the app
// needs no Python; the terminal scripts keep their own copy).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse } from "smol-toml";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { APP_ROOT, DATA, NURB_PYTHON, OPENSCAD, ORCA } from "./config.js";
import { hexFor, type Job } from "./jobs.js";
import * as parts3mf from "./parts3mf.js";

type Log = (line: string) => void;

/** gcode/<job>.gcode, or gcode/<job>-x<n>.gcode for n to a plate. */
export const gcodeName = (job: string, perPlate = 1) => (perPlate > 1 ? `${job}-x${perPlate}` : job);

/** Run a program; resolves with its output, rejects with the tail of it. */
function run(cmd: string, args: string[], what: string, cwd = DATA): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (c: Buffer) => { out = (out + c.toString()).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => reject(new Error(`${what}: couldn't run ${cmd} (${e.message})`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed (exit ${code}):\n${out.trim().split("\n").slice(-8).join("\n")}`))));
  });
}

const rel = (f: string) => path.relative(DATA, f);

async function renderScad(src: string, dest: string, params: Record<string, unknown>, log: Log): Promise<string> {
  log(`Rendering ${rel(src)}`);
  const defs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]);
  await run(OPENSCAD, [...defs, "-o", dest, src], "OpenSCAD render");
  if (!fs.existsSync(dest)) throw new Error("OpenSCAD render made no file.");
  return dest;
}

async function renderNurb(src: string, dest: string, params: Record<string, unknown>, log: Log): Promise<string> {
  log(`Building ${rel(src)} with nurb`);
  const sets = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  await run(NURB_PYTHON, [path.join(APP_ROOT, "scripts/nurb_part.py"), src, dest, ...sets], "nurb build");
  if (!fs.existsSync(dest)) throw new Error("nurb build made no file.");
  return dest;
}

/** The job's [overrides.process] on top of the shared process profile. */
function withOverrides(processFile: string, overrides: Record<string, unknown>, out: string): string {
  if (!Object.keys(overrides).length) return processFile;
  const f = path.join(out, "process.json");
  const base = JSON.parse(fs.readFileSync(processFile, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...base, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])) }));
  return f;
}

/**
 * A filament profile per part, coloured like it, and the purge table to go with them.
 * The CLI crashes on a multi-filament object without filament colours and a flush table;
 * the colours only matter for purging, not for which slot prints.
 */
function multiFilament(processFile: string, filament: string, colors: string[], out: string): [string, string[]] {
  const base = JSON.parse(fs.readFileSync(filament, "utf8"));
  const files = colors.map((color, i) => {
    const f = path.join(out, `filament-${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...base, filament_colour: [hexFor(color)] }));
    return f;
  });
  const n = colors.length;
  const proc = JSON.parse(fs.readFileSync(processFile, "utf8"));
  proc.flush_volumes_matrix = Array.from({ length: n * n }, (_, k) => (Math.floor(k / n) === k % n ? "0" : "280"));
  proc.flush_volumes_vector = Array(2 * n).fill("140");
  // the first layer goes down in [parts] order (Orca otherwise picks, e.g. the disc before its inlay)
  proc.first_layer_print_sequence = Array.from({ length: n }, (_, i) => String(i + 1));
  // the prime tower goes in the back-right corner that parts3mf.grid() keeps clear
  proc.wipe_tower_x = [String(parts3mf.TOWER[0] + 12)];
  proc.wipe_tower_y = [String(parts3mf.TOWER[1] + 12)];
  const f = path.join(out, "process.json");
  fs.writeFileSync(f, JSON.stringify(proc));
  return [f, files];
}

/** A copy of a 3MF with every object on filament 1, so our filament profile applies. */
function singleFilament(src: string, dest: string): string {
  const files = unzipSync(fs.readFileSync(src));
  const config = files["Metadata/model_settings.config"];
  if (config) files["Metadata/model_settings.config"] = strToU8(strFromU8(config).replace(/(key="extruder" value=")\d+"/g, (_, head) => `${head}1"`));
  fs.writeFileSync(dest, zipSync(files));
  return dest;
}

/** Slice a job to gcode/<name>.gcode (or -x<n> for n on a plate); `log` gets progress lines. */
export async function sliceJob(job: Job, perPlate: number, log: Log): Promise<string> {
  const raw = parse(fs.readFileSync(path.join(DATA, job.file), "utf8")) as any;
  let model = path.join(DATA, job.model);
  const p = Object.fromEntries(Object.entries(job.profiles).map(([k, v]) => [k, path.join(DATA, v)]));
  for (const f of [model, p.machine, p.process, p.filament]) {
    if (!f || !fs.existsSync(f)) throw new Error(`Missing file: ${f ? rel(f) : "a profile in the job's [profiles]"}`);
  }
  const ext = path.extname(model);
  if (perPlate > 1 && ext !== ".scad" && ext !== ".py") throw new Error("Filling the plate works for OpenSCAD and nurb models; this one is a ready-made file.");

  const out = path.join(DATA, "gcode", gcodeName(job.name, perPlate));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    // the job's [overrides.process] go on top every slice, so a job can tune a shared profile
    let processFile = withOverrides(p.process, raw.overrides?.process ?? {}, out);
    let filaments = [p.filament];
    const parts: Record<string, string> | undefined = raw.parts;
    if (parts && Object.keys(parts).length) {
      if (ext !== ".scad") throw new Error("[parts] needs an OpenSCAD model (each part renders with -D part=...)");
      const rendered: [string, string, number][] = [];
      for (const [i, name] of Object.keys(parts).entries()) {
        rendered.push([name, await renderScad(model, path.join(out, `part-${name}.stl`), { ...raw.scad, part: `"${name}"` }, log), i + 1]);
      }
      model = parts3mf.write(rendered, path.join(out, "model.3mf"), job.name, perPlate);
      [processFile, filaments] = multiFilament(processFile, p.filament, Object.values(parts).map(String), out);
    } else if (ext === ".scad" || ext === ".py") {
      const stl = ext === ".scad"
        ? await renderScad(model, path.join(out, "model.stl"), raw.scad ?? {}, log)
        : await renderNurb(model, path.join(out, "model.stl"), raw.params ?? {}, log);
      model = parts3mf.write([[job.name, stl, 1]], path.join(out, "model.3mf"), job.name, perPlate);
    } else if (ext === ".3mf") {
      model = singleFilament(model, path.join(out, "model.3mf"));
    }

    // OpenSCAD and nurb models arrive centred and laid out as intended (see parts3mf); Orca's
    // auto-arrange would spin them, so it's off for those. Downloaded 3MFs keep Orca's placement.
    const placed = ext === ".scad" || ext === ".py";
    const args = [
      "--load-settings", `${p.machine};${processFile}`,
      "--load-filaments", filaments.join(";"),
      "--slice", "0",
      ...(placed ? ["--arrange", "0", "--orient", "0"] : []),
      "--outputdir", out,
      model,
    ];
    log("Slicing with OrcaSlicer…");
    await run(ORCA, args, "OrcaSlicer");
    const gcodes = fs.readdirSync(out).filter((f) => f.endsWith(".gcode"))
      .map((f) => path.join(out, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    if (!gcodes.length) throw new Error("OrcaSlicer finished but wrote no G-code.");
    const final = path.join(DATA, "gcode", `${gcodeName(job.name, perPlate)}.gcode`);
    fs.renameSync(gcodes[gcodes.length - 1], final);
    log(`G-code: ${rel(final)}`);
    return final;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
