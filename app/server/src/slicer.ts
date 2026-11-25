// Slicing with OrcaSlicer's CLI: the one implementation, used by the app and (through
// scripts/slice) by scripts/run.py. Ported from run.py's slice_job and friends.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse } from "smol-toml";
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { APP_ROOT, DATA, NURB_PYTHON, OPENSCAD, ORCA } from "./config.js";
import { gcodePath, hexFor, MATERIAL_PROFILES, type Material } from "./jobs.js";
import { NOZZLE_PROFILES, STOCK, type Nozzle } from "./nozzle.js";
import * as parts3mf from "./parts3mf.js";

type Log = (line: string) => void;

// The 3MFs written here are scratch files OrcaSlicer reads straight away: store them uncompressed.
// Deflating hundreds of MB of model XML in JavaScript took most of a minute for a plate of pots.
const STORE = { level: 0 } as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Toml = Record<string, any>;

export interface SliceOptions {
  perPlate?: number; // > 1: that many laid out on the bed (OpenSCAD and nurb jobs)
  material?: Material; // a spool other than PLA swaps in its filament profile
  nozzle?: Nozzle; // a nozzle other than the stock 0.4 swaps in its machine profile and a process overlay
  oneColor?: boolean; // a multi-colour job (OpenSCAD parts, a plate) all on one filament
}

/** Process settings Orca only takes for the whole plate, not per object: on for the plate if any part wants it. */
const PLATE_WIDE = new Set(["reduce_crossing_wall"]);

const fail = (message: string) => new Error(message);
const rel = (f: string) => path.relative(DATA, f);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const readToml = (file: string) => parse(fs.readFileSync(file, "utf8")) as Toml;

/** What this process has started (OpenSCAD, OrcaSlicer, nurb), so stopping a slice stops them too. */
const programs = new Set<ReturnType<typeof spawn>>();
export function stopPrograms() { for (const p of programs) p.kill("SIGTERM"); }

/** Run a program; rejects with the tail of its output. */
function run(cmd: string, args: string[], what: string, cwd = DATA): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    programs.add(child);
    child.on("exit", () => programs.delete(child));
    let out = "";
    const keep = (c: Buffer) => { out = (out + c.toString()).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => reject(fail(`${what}: couldn't run ${cmd} (${e.message})`)));
    child.on("close", (code) => (code === 0 ? resolve()
      : reject(fail(`${what} failed (exit ${code}):\n${out.trim().split("\n").slice(-8).join("\n")}`))));
  });
}

// ---- jobs and plates ----

/** A job file (jobs/<name>.toml or plates/<name>.toml), with a plate's members filled in. */
export function loadJob(file: string): Toml {
  const abs = path.resolve(DATA, file);
  const job = readToml(abs);
  if ("plate" in job) plateMembers(job, abs);
  for (const key of ["name", "model", "profiles"]) if (!(key in job)) throw fail(`${rel(abs)}: missing '${key}'`);
  return job;
}

/**
 * Fill in a plate's members ([job, count]), profiles and model from the jobs it holds.
 * Every part slices with the first's profiles; the process overrides all the parts share go
 * on the plate, and each part's others go on its object (see mergePlate).
 */
function plateMembers(job: Toml, file: string) {
  const byName = new Map<string, Toml>();
  const dir = path.join(DATA, "jobs");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()) {
    const j = readToml(path.join(dir, f));
    byName.set(j.name, j);
  }
  const members: [Toml, number][] = [];
  for (const [name, count] of Object.entries(job.plate as Record<string, number>)) {
    const member = byName.get(name);
    if (!member) throw fail(`${rel(file)}: no job named '${name}'`);
    if (!String(member.model ?? "").endsWith(".3mf")) throw fail(`${rel(file)}: '${name}' isn't a part of a .3mf; plates hold those`);
    if (Number(count) > 0) members.push([member, Number(count)]);
  }
  if (!members.length) throw fail(`${rel(file)}: the plate is empty`);
  const first = members[0][0];
  if (members.some(([m]) => !same(m.profiles, first.profiles))) throw fail(`${rel(file)}: the parts use different profiles; a plate needs them all the same`);
  const overrides: Toml[] = members.map(([m]) => m.overrides?.process ?? {});
  const shared: Toml = Object.fromEntries(Object.entries(overrides[0]).filter(([k, v]) => overrides.every((o) => same(o[k], v))));
  for (const k of PLATE_WIDE) {
    const on = overrides.filter((o) => k in o).map((o) => o[k]);
    if (on.length) shared[k] = on.reduce((a, b) => (b > a ? b : a));
  }
  job.members = members;
  job.profiles = first.profiles;
  job.model = first.model;
  job.overrides = { process: shared };
}

/** Where a job's G-code goes for these options (the app's naming, see jobs.ts). */
export function gcodeFor(job: Toml, o: SliceOptions = {}): string {
  return gcodePath(job.name, o.perPlate ?? 1, o.material ?? "pla", o.nozzle ?? STOCK, o.oneColor ?? false);
}

// ---- rendering ----

async function renderScad(src: string, dest: string, params: Toml, log: Log): Promise<string> {
  log(`Rendering ${rel(src)}`);
  const defs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]);
  await run(OPENSCAD, [...defs, "-o", dest, src], "OpenSCAD render");
  if (!fs.existsSync(dest)) throw fail("OpenSCAD render made no file.");
  return dest;
}

async function renderNurb(src: string, dest: string, params: Toml, log: Log): Promise<string> {
  log(`Building ${rel(src)} with nurb`);
  const sets = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  await run(NURB_PYTHON, [path.join(APP_ROOT, "scripts/nurb_part.py"), src, dest, ...sets], "nurb build");
  if (!fs.existsSync(dest)) throw fail("nurb build made no file.");
  return dest;
}

// ---- profiles ----

/** Overrides on top of the process profile (lists stay lists; everything else becomes a string). */
function withOverrides(processFile: string, overrides: Toml, out: string): string {
  if (!Object.keys(overrides).length) return processFile;
  const f = path.join(out, "process.json");
  const base = JSON.parse(fs.readFileSync(processFile, "utf8"));
  const set = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, Array.isArray(v) ? v : String(v)]));
  fs.writeFileSync(f, JSON.stringify({ ...base, ...set }));
  return f;
}

/**
 * A filament profile per part, coloured like it, and the purge table to go with them.
 * The CLI crashes on a multi-filament object without filament colours and a flush table;
 * the colours only matter for purging, not for which slot prints.
 */
export function multiFilament(processFile: string, filament: string, colors: string[], out: string): [string, string[]] {
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

// ---- downloaded 3MFs ----

const text = (z: Unzipped, name: string) => strFromU8(z[name]);

/** The build object named `name` in a 3MF's model_settings.config, and the plate it's on (0: none). */
function objectOnPlate(config: string, name: string, src: string): [string, number] {
  const ids = [...config.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)].filter((m) => m[2] === name).map((m) => m[1]);
  if (!ids.length) {
    const have = [...config.matchAll(/<object id="\d+">\s*<metadata key="name" value="([^"]*)"/g)].map((m) => m[1]);
    throw fail(`No object named '${name}' in ${rel(src)} (has ${have.join(", ")}).`);
  }
  for (const block of config.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    if (new RegExp(`key="object_id" value="${ids[0]}"`).test(block[1]))
      return [ids[0], Number(block[1].match(/key="plater_id" value="(\d+)"/)![1])];
  }
  return [ids[0], 0];
}

/**
 * Changed files that add a disc (radius, height mm) under build object `keep`, as one more
 * solid part. The disc sits in the object's own coordinates, centred on its main mesh and flush
 * with that mesh's underside (after the component's transform), so the slicer unions it with
 * the base: a recess up to `height` deep inside `radius` prints solid.
 */
function baseFill(z: Unzipped, keep: string, fill: { radius: number; height: number }): Record<string, string> {
  let root = text(z, "3D/3dmodel.model");
  const obj = root.match(new RegExp(`<object id="${keep}"[^>]*>([\\s\\S]*?)</object>`))!;
  const comp = obj[1].match(/<component p:path="([^"]+)" objectid="(\d+)"[^>]*?transform="([^"]+)"/);
  if (!comp) throw fail("fill_base needs an object made of parts (a Bambu/Orca 3MF).");
  const file = comp[1].replace(/^\//, "");
  const meshId = comp[2];
  const m = comp[3].split(/\s+/).map(Number);
  let sub = text(z, file);
  const mesh = sub.match(new RegExp(`<object id="${meshId}"[^>]*>([\\s\\S]*?)</object>`))![1];
  const pts = [...mesh.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((v) => {
    const [x, y, zz] = [Number(v[1]), Number(v[2]), Number(v[3])];
    return [0, 1, 2].map((c) => x * m[c] + y * m[3 + c] + zz * m[6 + c] + m[9 + c]);
  });
  let [x0, x1, y0, y1, z0] = [Infinity, -Infinity, Infinity, -Infinity, Infinity];
  for (const [x, y, zz] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, zz); }
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [r, h, n] = [Number(fill.radius), Number(fill.height), 96];
  const ring = Array.from({ length: n }, (_, i) => [cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]);
  const verts = [...ring.map(([x, y]) => [x, y, z0]), ...ring.map(([x, y]) => [x, y, z0 + h]), [cx, cy, z0], [cx, cy, z0 + h]];
  const tris: number[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([i, j, n + i], [j, n + j, n + i], [2 * n, j, i], [2 * n + 1, n + i, n + j]); // normals out
  }
  const newId = String(Math.max(...[...(sub + root).matchAll(/<object id="(\d+)"/g)].map((x) => Number(x[1]))) + 1);
  const disc = `<object id="${newId}" type="model"><mesh><vertices>`
    + verts.map(([x, y, zz]) => `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${zz.toFixed(4)}"/>`).join("")
    + "</vertices><triangles>" + tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")
    + "</triangles></mesh></object>\n";
  sub = sub.replace("</resources>", disc + "</resources>");
  root = root.replace(new RegExp(`(<object id="${keep}"[^>]*>[\\s\\S]*?)(</components>)`),
    (_, a, b) => a + `<component p:path="/${file}" objectid="${newId}" transform="1 0 0 0 1 0 0 0 1 0 0 0" />\n` + b);
  let config = text(z, "Metadata/model_settings.config");
  config = config.replace(new RegExp(`(<object id="${keep}">[\\s\\S]*?)(\\s*</object>)`),
    (_, a, b) => a + `\n    <part id="${newId}" subtype="normal_part">\n      <metadata key="name" value="base fill"/>\n`
      + '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>' + b);
  return { [file]: sub, "3D/3dmodel.model": root, "Metadata/model_settings.config": config };
}

/**
 * A copy of a 3MF with every object on filament 1, so our filament profile applies.
 *
 * With `only` (an object's name), the copy keeps just that object; returns the copy and the
 * plate to slice (that object's, or 0 for every plate).
 *
 * Orca's CLI refuses files saved by Bambu Studio 2.x (exit 232, no message), so the copy
 * claims to be from 1.10; the objects, modifiers and layer ranges read fine. Colour painting
 * (paint_color on triangles) is dropped too: it outranks the object's filament, so a pot
 * painted filament 2 would swap filaments every layer.
 *
 * `fillBase` (needs `only`) adds a solid disc to that object, flush with its underside.
 */
export function singleFilament(src: string, dest: string, only?: string, fill?: { radius: number; height: number }): [string, number] {
  const z = unzipSync(fs.readFileSync(src));
  let plate = 0;
  let keep: string | null = null;
  if (only) [keep, plate] = objectOnPlate(text(z, "Metadata/model_settings.config"), only, src);
  const extra = keep && fill ? baseFill(z, keep, fill) : {};
  const others = (id: string, whole: string) => (id === keep ? whole : "");
  const out: Unzipped = {};
  for (const name of Object.keys(z)) {
    const isText = name in extra || name === "Metadata/model_settings.config" || name.endsWith(".model");
    if (!isText) { out[name] = z[name]; continue; }
    let data = extra[name] ?? strFromU8(z[name]);
    if (name === "Metadata/model_settings.config") {
      data = data.replace(/(key="extruder" value=")\d+"/g, (_, a) => `${a}1"`);
      if (keep) { // the other objects' settings and plate entries go with their build items
        data = data.replace(/\s*<object id="(\d+)">[\s\S]*?<\/object>/g, (w, id) => others(id, w));
        data = data.replace(/\s*<assemble_item object_id="(\d+)"[^>]*\/>/g, (w, id) => others(id, w));
        data = data.replace(/\s*<model_instance>(?:(?!<\/model_instance>)[\s\S])*?key="object_id" value="(\d+)"(?:(?!<\/model_instance>)[\s\S])*<\/model_instance>/g,
          (w, id) => others(id, w));
      }
    } else if (name === "3D/3dmodel.model") {
      data = data.replace(/(<metadata name="Application">BambuStudio-)0*[2-9]\d*\.[\d.]+/g, (_, a) => `${a}01.10.00.00`);
      if (keep) data = data.replace(/\s*<item\b[^>]*?\bobjectid="(\d+)"[^>]*\/>/g, (w, id) => others(id, w));
    }
    if (name.endsWith(".model")) data = data.replace(/ paint_color="[^"]*"/g, "");
    out[name] = strToU8(data);
  }
  fs.writeFileSync(dest, zipSync(out, STORE));
  return [dest, plate];
}

/**
 * One 3MF holding each of a plate's parts, as many times as it asks, on plate 1.
 * Each part is prepared as when sliced on its own (singleFilament: just its object, any
 * fill_base), then its object, mesh files and settings are copied in. An object prints on the
 * filament of its colour and carries the process overrides it doesn't share with the rest of
 * the plate (plateMembers). Returns the file and its plate.
 */
export function mergePlate(job: Toml, colors: string[], out: string, oneColor: boolean): [string, number] {
  const shared: Toml = job.overrides.process;
  const objects: string[] = [], items: string[] = [], configs: string[] = [], instances: string[] = [];
  const files: Record<string, string> = {};
  let base: string | null = null;
  let nextId = 1;
  (job.members as [Toml, number][]).forEach(([member, count], i) => {
    const n = i + 1;
    const [src] = singleFilament(path.join(DATA, member.model), path.join(out, `part-${n}.3mf`), member.object, member.fill_base);
    base ??= src;
    const z = unzipSync(fs.readFileSync(src));
    const root = text(z, "3D/3dmodel.model");
    const config = text(z, "Metadata/model_settings.config");
    const item = root.match(/<item\b[^>]*?\bobjectid="(\d+)"[^>]*\/>/)!;
    const keep = item[1];
    // its rotation, but over the middle of the bed: a part on another of its file's plates
    // sits off to the side, where Orca would leave it (arrange then spreads them out)
    const t = item[0].match(/\btransform="([^"]+)"/)![1].split(/\s+/);
    const transform = [...t.slice(0, 9), "130", "130", t[11]].join(" ");
    let obj = root.match(new RegExp(`<object id="${keep}"[^>]*>[\\s\\S]*?</object>`))![0];
    let settings = config.match(new RegExp(`<object id="${keep}">[\\s\\S]*?</object>`))![0];
    // Orca keys mesh objects by id across every file, so each part's go up by 1000 x its number
    const subId = (_: string, a: string, id: string) => `${a}"${1000 * n + Number(id)}"`;
    const renamed = new Map<string, string>();
    for (const p of [...new Set([...obj.matchAll(/p:path="([^"]+)"/g)].map((x) => x[1]))].sort()) {
      const to = `/3D/Objects/plate_${n}_${path.posix.basename(p)}`;
      renamed.set(p, to);
      files[to.replace(/^\//, "")] = text(z, p.replace(/^\//, "")).replace(/(<object id=)"(\d+)"/g, subId);
    }
    obj = obj.replace(/(<component\b[^>]*?\bobjectid=)"(\d+)"/g, subId);
    settings = settings.replace(/(<part id=)"(\d+)"/g, subId);
    const own = Object.entries(member.overrides?.process ?? {}).filter(([k, v]) => !PLATE_WIDE.has(k) && !same(shared[k], v));
    const extruder = oneColor ? 1 : colors.indexOf(hexFor(member.color)) + 1;
    for (let c = 0; c < count; c++) {
      const oid = String(nextId++);
      let o = obj.replace(/^<object id="\d+"/, `<object id="${oid}"`);
      o = o.replace(/p:UUID="[^"]*"/g, () => `p:UUID="${randomUUID()}"`);
      for (const [a, b] of renamed) o = o.split(`p:path="${a}"`).join(`p:path="${b}"`);
      objects.push(o);
      items.push(`<item objectid="${oid}" p:UUID="${randomUUID()}" transform="${transform}" printable="1" />`);
      let cfg = settings.replace(/^<object id="\d+">/, `<object id="${oid}">`);
      cfg = cfg.replace(/(key="extruder" value=")\d+"/g, (_, a) => `${a}${extruder}"`);
      cfg = cfg.replace(/(<metadata key="name" value="[^"]*"\/>)/, (_, a) => a + own.map(([k, v]) => `\n    <metadata key="${k}" value="${v}"/>`).join(""));
      configs.push(cfg);
      instances.push(`    <model_instance>\n      <metadata key="object_id" value="${oid}"/>\n`
        + `      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${1000 + Number(oid)}"/>\n    </model_instance>`);
    }
  });
  const dest = path.join(out, "model.3mf");
  const skip = /^(3D\/Objects\/|3D\/3dmodel\.model$|3D\/_rels\/3dmodel\.model\.rels$|Metadata\/(model_settings\.config|layer_config_ranges\.xml|cut_information\.xml|plate_\d+\.json)$)/;
  const z = unzipSync(fs.readFileSync(base!));
  let root = text(z, "3D/3dmodel.model");
  root = root.replace(/<resources>[\s\S]*<\/resources>/, () => "<resources>\n" + objects.join("\n") + "\n </resources>");
  root = root.replace(/(<build\b[^>]*>)[\s\S]*?(<\/build>)/, (_, a, b) => a + "\n" + items.join("\n") + "\n " + b);
  const zout: Unzipped = {};
  for (const name of Object.keys(z)) if (!skip.test(name)) zout[name] = z[name];
  zout["3D/3dmodel.model"] = strToU8(root);
  for (const [name, data] of Object.entries(files)) zout[name] = strToU8(data);
  const rels = Object.keys(files).map((name, i) =>
    `\n <Relationship Target="/${name}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join("");
  zout["3D/_rels/3dmodel.model.rels"] = strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships '
    + `xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}\n</Relationships>`);
  zout["Metadata/model_settings.config"] = strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  ' + configs.join("\n  ")
    + '\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n'
    + '    <metadata key="locked" value="false"/>\n' + instances.join("\n") + "\n  </plate>\n</config>\n");
  fs.writeFileSync(dest, zipSync(zout, STORE));
  return [dest, 1];
}

// ---- slicing ----

/** Slice a job file (relative to the library, or absolute); `log` gets progress lines. Returns the G-code's path. */
export async function sliceJob(file: string, o: SliceOptions, log: Log): Promise<string> {
  const job = loadJob(file);
  const perPlate = o.perPlate ?? 1;
  const material = o.material ?? "pla";
  const nozzle = o.nozzle ?? STOCK;
  const oneColor = o.oneColor ?? false;
  let model = path.join(DATA, job.model);
  const p: Record<string, string> = Object.fromEntries(Object.entries(job.profiles as Record<string, string>).map(([k, v]) => [k, path.join(DATA, v)]));
  if (material !== "pla") p.filament = path.join(DATA, MATERIAL_PROFILES[material]);
  if (nozzle !== STOCK) [p.machine, p.nozzle] = NOZZLE_PROFILES[nozzle].map((f) => path.join(DATA, f));
  for (const f of [model, ...Object.values(p)]) if (!fs.existsSync(f)) throw fail(`Missing file: ${rel(f)}`);
  const ext = path.extname(model);
  if (perPlate > 1 && ext !== ".scad" && ext !== ".py") throw fail("Filling the plate works for OpenSCAD and nurb models; this one is a ready-made file.");

  const final = gcodeFor(job, o);
  const out = final.replace(/\.gcode$/, "");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    let plate = 0; // 0 = every plate
    // the job's [overrides.process] go on top every slice, so a job can tune a shared profile
    const overrides = { ...(p.nozzle ? JSON.parse(fs.readFileSync(p.nozzle, "utf8")) : {}), ...(job.overrides?.process ?? {}) };
    let processFile = withOverrides(p.process, overrides, out);
    let filaments = [p.filament];
    const parts: Record<string, string> | undefined = job.parts;
    if (parts && Object.keys(parts).length) {
      if (ext !== ".scad") throw fail("[parts] needs an OpenSCAD model (each part renders with -D part=...)");
      const rendered: [string, string, number][] = [];
      for (const [i, name] of Object.keys(parts).entries()) {
        rendered.push([name, await renderScad(model, path.join(out, `part-${name}.stl`), { ...job.scad, part: `"${name}"` }, log), oneColor ? 1 : i + 1]);
      }
      model = parts3mf.write(rendered, path.join(out, "model.3mf"), job.name, perPlate);
      if (!oneColor) [processFile, filaments] = multiFilament(processFile, p.filament, Object.values(parts).map(String), out);
    } else if (ext === ".scad" || ext === ".py") {
      const stl = ext === ".scad"
        ? await renderScad(model, path.join(out, "model.stl"), job.scad ?? {}, log)
        : await renderNurb(model, path.join(out, "model.stl"), job.params ?? {}, log);
      model = parts3mf.write([[job.name, stl, 1]], path.join(out, "model.3mf"), job.name, perPlate);
    } else if (job.members) {
      let colors = [...new Set((job.members as [Toml, number][]).map(([m]) => hexFor(String(m.color))))];
      [model, plate] = mergePlate(job, colors, out, oneColor);
      colors = oneColor ? colors.slice(0, 1) : colors;
      if (colors.length > 1) [processFile, filaments] = multiFilament(processFile, p.filament, colors, out);
    } else if (ext === ".3mf") {
      [model, plate] = singleFilament(model, path.join(out, "model.3mf"), job.object, job.fill_base);
    }

    // OpenSCAD and nurb models arrive centred and laid out as intended (see parts3mf); Orca's
    // auto-arrange would spin them, so it's off for those. Downloaded 3MFs keep Orca's placement.
    const placed = String(job.model).endsWith(".scad") || String(job.model).endsWith(".py");
    const args = [
      "--load-settings", `${p.machine};${processFile}`,
      "--load-filaments", filaments.join(";"),
      "--slice", String(plate),
      ...(placed ? ["--arrange", "0", "--orient", "0"] : []),
      // a plate's parts arrive where their own files put them; arrange spreads them out, all on plate 1
      // (unasked, it moves each colour to a plate of its own)
      ...(job.members ? ["--arrange", "1", "--orient", "0", "--allow-multicolor-oneplate"] : []),
      "--outputdir", out,
      model,
    ];
    log("Slicing with OrcaSlicer…");
    // a plate of big parts takes minutes: say it's still going
    const started = Date.now();
    const ticker = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      log(`Still slicing… ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
    }, 15_000);
    try { await run(ORCA, args, "OrcaSlicer"); } finally { clearInterval(ticker); }
    const gcodes = fs.readdirSync(out).filter((f) => f.endsWith(".gcode"))
      .map((f) => path.join(out, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    if (!gcodes.length) throw fail("OrcaSlicer finished but wrote no G-code.");
    fs.renameSync(gcodes[gcodes.length - 1], final);
    log(`G-code: ${rel(final)}`);
    return final;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
