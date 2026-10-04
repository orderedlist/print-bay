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

/** Every mesh object in the 3MF, in its own coordinates (placement ignored). */
function threemfToStl(src: string, dest: string) {
  const files = unzipSync(fs.readFileSync(src), { filter: (f) => f.name.endsWith(".model") });
  const triangles: Vec[][] = [];
  for (const data of Object.values(files)) {
    const xml = strFromU8(data);
    for (const obj of xml.matchAll(/<object\b[\s\S]*?<\/object>/g)) {
      const verts: Vec[] = [...obj[0].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)]
        .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
      for (const t of obj[0].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g))
        triangles.push([verts[+t[1]], verts[+t[2]], verts[+t[3]]]);
    }
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
 * Path to an STL of the model with its job's overrides. OpenSCAD models render
 * upright (as used) for viewing, or laid out as sliced with `print: true`.
 */
export function meshFor(modelId: string, opts: { print?: boolean } = {}): Promise<string> {
  const model = getModel(modelId);
  if (!model.file) throw Object.assign(new Error(`${modelId} has no mesh`), { statusCode: 404 });
  const src = path.join(ROOT, model.file);
  if (src.endsWith(".stl")) return Promise.resolve(src);

  const job = model.jobs[0] ? getJob(model.jobs[0].name) : null;
  const params = job?.scad ?? {};
  const print = Boolean(opts.print) && (src.endsWith(".scad") || src.endsWith(".py"));
  const name = print ? `${modelId}.print` : modelId;
  const dest = path.join(CACHE, `${name}.stl`);
  const stamp = path.join(CACHE, `${name}.stl.key`);
  const parts = src.endsWith(".scad") ? job?.parts ?? [] : [];
  const key = JSON.stringify({ mtime: fs.statSync(src).mtimeMs, params, parts });
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
        threemfToStl(src, tmp);
      }
      fs.renameSync(tmp, dest);
      fs.writeFileSync(stamp, key);
      return dest;
    })().finally(() => inflight.delete(name));
    inflight.set(name, work);
  }
  return inflight.get(name)!;
}
