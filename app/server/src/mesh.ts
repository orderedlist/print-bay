// Meshes for the viewer, as binary STL (ported from scripts/view.py).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";
import { CACHE, NURB_PYTHON, OPENSCAD, ROOT } from "./config.js";
import { getModel, getJob } from "./jobs.js";

const run = promisify(execFile);
type Vec = [number, number, number];

function writeStl(triangles: Vec[][], dest: string) {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.writeUInt32LE(triangles.length, 80);
  let o = 84;
  for (const tri of triangles) {
    o += 12; // normal: left zero, the viewer recomputes it
    for (const v of tri) for (const c of v) { buf.writeFloatLE(c, o); o += 4; }
    o += 2;
  }
  fs.writeFileSync(dest, buf);
}

// A 3MF transform is 12 numbers, a 4x3 matrix applied to row vectors: p' = [x y z 1] * M.
type Mat = number[];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseMat = (s?: string): Mat => (s ? s.trim().split(/\s+/).map(Number) : IDENTITY);
const apply = (m: Mat, [x, y, z]: Vec): Vec =>
  [0, 1, 2].map((c) => x * m[c] + y * m[3 + c] + z * m[6 + c] + m[9 + c]) as Vec;
/** `inner` then `outer`. */
const compose = (inner: Mat, outer: Mat): Mat =>
  [0, 1, 2, 3].flatMap((row) => {
    const p = apply(outer, [inner[row * 3], inner[row * 3 + 1], inner[row * 3 + 2]]);
    // rows 0-2 are directions: they take outer's rotation but not its translation
    return row < 3 ? p.map((v, c) => v - outer[9 + c]) : p;
  });

interface Obj3mf { type: string; verts: Vec[]; tris: number[][]; components: { path?: string; id: string; m: Mat }[] }

/**
 * Build-item object ids of the objects named `object` (from Metadata/model_settings.config);
 * null for every object.
 */
function namedObjects(zip: Record<string, Uint8Array>, object?: string): Set<string> | null {
  const config = zip["Metadata/model_settings.config"];
  if (!object || !config) return null;
  return new Set([...strFromU8(config).matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)]
    .filter((m) => m[2] === object).map((m) => m[1]));
}

/** How many printable objects a 3MF's build holds (1 when a job picks one): the pieces it comes off the bed as. */
export function threemfPieces(src: string, object?: string): number {
  if (object) return 1;
  const zip = unzipSync(fs.readFileSync(src), { filter: (f) => f.name === "3D/3dmodel.model" });
  return [...strFromU8(zip["3D/3dmodel.model"] ?? new Uint8Array()).matchAll(/<item\b/g)].length || 1;
}

/**
 * The 3MF's build, placed as the file lays it out; with `object`, only the object of that name.
 * Modifier, support and other non-model volumes are left out.
 */
function threemfToStl(src: string, dest: string, object?: string) {
  const files = unzipSync(fs.readFileSync(src), { filter: (f) => f.name.endsWith(".model") || f.name === "Metadata/model_settings.config" });
  const only = namedObjects(files, object);
  const objects = new Map<string, Obj3mf>(); // "<file>#<id>"
  let root = "";
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith(".model")) continue;
    const file = "/" + name.replace(/^\//, "");
    const xml = strFromU8(data);
    if (/<build\b/.test(xml)) root ||= file;
    for (const obj of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const attr = (k: string) => obj[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
      objects.set(`${file}#${attr("id")}`, {
        type: attr("type") ?? "model",
        verts: [...obj[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => [+m[1], +m[2], +m[3]]),
        tris: [...obj[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((t) => [+t[1], +t[2], +t[3]]),
        components: [...obj[2].matchAll(/<component\b([^>]*?)\/?>/g)].map((c) => ({
          path: c[1].match(/\bp:path="([^"]*)"/)?.[1],
          id: c[1].match(/\bobjectid="([^"]*)"/)![1],
          m: parseMat(c[1].match(/\btransform="([^"]*)"/)?.[1]),
        })),
      });
    }
  }
  const triangles: Vec[][] = [];
  const emit = (key: string, m: Mat, depth = 0) => {
    const o = objects.get(key);
    if (!o || o.type !== "model" || depth > 8) return;
    const verts = o.verts.map((v) => apply(m, v));
    for (const t of o.tris) triangles.push([verts[t[0]], verts[t[1]], verts[t[2]]]);
    const file = key.split("#")[0];
    for (const c of o.components) emit(`${c.path ?? file}#${c.id}`, compose(c.m, m), depth + 1);
  };
  const rootXml = root ? strFromU8(files[root.slice(1)]) : "";
  const items = [...rootXml.matchAll(/<item\b([^>]*?)\/?>/g)];
  if (items.length) {
    for (const it of items) {
      if (only && !only.has(it[1].match(/\bobjectid="([^"]*)"/)![1])) continue;
      emit(`${root}#${it[1].match(/\bobjectid="([^"]*)"/)![1]}`, parseMat(it[1].match(/\btransform="([^"]*)"/)?.[1]));
    }
  } else {
    for (const [key, o] of objects) if (!o.components.length) emit(key, IDENTITY);
  }
  writeStl(triangles, dest);
}

/** Triangles of a binary STL. */
function readBinaryStl(file: string): Buffer[] {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  return Array.from({ length: n }, (_, t) => buf.subarray(84 + t * 50, 84 + t * 50 + 50));
}

/** One STL of all the parts, each triangle's attribute bytes holding its part number (1, 2, ...). */
function joinParts(files: string[], dest: string) {
  const tris = files.flatMap((f, i) => readBinaryStl(f).map((t) => {
    const copy = Buffer.from(t);
    copy.writeUInt16LE(i + 1, 48);
    return copy;
  }));
  const head = Buffer.alloc(84);
  head.write("Print Bay multi-colour: part number in the attribute bytes");
  head.writeUInt32LE(tris.length, 80);
  fs.writeFileSync(dest, Buffer.concat([head, ...tris]));
}

const inflight = new Map<string, Promise<string>>();

/**
 * Path to an STL of the model with its job's overrides (`job`, or the model's first). OpenSCAD
 * models render upright (as used) for viewing, or laid out as sliced with `print: true`.
 */
export function meshFor(modelId: string, opts: { print?: boolean; job?: string } = {}): Promise<string> {
  const model = getModel(modelId);
  const jobName = opts.job && model.jobs.some((j) => j.name === opts.job) ? opts.job : model.jobs[0]?.name;
  const job = jobName ? getJob(jobName) : null;
  const file = job?.model ?? model.file; // a model's jobs can each have their own file (a 3MF per print profile)
  if (!file) throw Object.assign(new Error(`${modelId} has no mesh`), { statusCode: 404 });
  const src = path.join(ROOT, file);
  if (src.endsWith(".stl")) return Promise.resolve(src);

  const params = job?.scad ?? {};
  const print = Boolean(opts.print) && (src.endsWith(".scad") || src.endsWith(".py"));
  const object = src.endsWith(".3mf") ? job?.object : undefined;
  const base = object ? `${modelId}.${job!.name}` : modelId; // each part of a multi-part 3MF caches on its own
  const name = print ? `${base}.print` : base;
  const dest = path.join(CACHE, `${name}.stl`);
  const stamp = path.join(CACHE, `${name}.stl.key`);
  const parts = src.endsWith(".scad") ? job?.parts ?? [] : [];
  // layout: 2 = 3MFs placed as their build lays them out (earlier caches stacked every object at its origin)
  const key = JSON.stringify({ mtime: fs.statSync(src).mtimeMs, params, parts, ...(src.endsWith(".3mf") ? { layout: 2, object } : {}) });
  if (fs.existsSync(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === key)
    return Promise.resolve(dest);

  if (!inflight.has(name)) {
    const work = (async () => {
      const tmp = dest + ".tmp.stl";
      if (src.endsWith(".py")) { // a nurb part: its function, with the job's [params]
        const sets = [...(print ? [] : ["upright=True"]), ...Object.entries(params).map(([k, v]) => `${k}=${v}`)];
        await run(NURB_PYTHON, [path.join(ROOT, "scripts/nurb_part.py"), src, tmp, ...sets], { cwd: ROOT, maxBuffer: 1 << 24, timeout: 300_000 });
      } else if (src.endsWith(".scad")) {
        const defs = [...(print ? [] : ["-D", "upright=true"]), ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`])];
        if (parts.length) { // each colour on its own, then joined with part numbers
          const files = await Promise.all(parts.map(async (p) => {
            const f = `${dest}.${p.name}.tmp.stl`;
            await run(OPENSCAD, [...defs, "-D", `part="${p.name}"`, "--export-format", "binstl", "-o", f, src], { maxBuffer: 1 << 24 });
            return f;
          }));
          joinParts(files, tmp);
          for (const f of files) fs.rmSync(f, { force: true });
        } else {
          await run(OPENSCAD, [...defs, "-o", tmp, src], { maxBuffer: 1 << 24 });
        }
      } else {
        threemfToStl(src, tmp, object);
      }
      fs.renameSync(tmp, dest);
      fs.writeFileSync(stamp, key);
      return dest;
    })().finally(() => inflight.delete(name));
    inflight.set(name, work);
  }
  return inflight.get(name)!;
}
