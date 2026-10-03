// Meshes for the viewer, as binary STL (ported from scripts/view.py).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";
import { CACHE, OPENSCAD, ROOT } from "./config.js";
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

const inflight = new Map<string, Promise<string>>();

/** Path to an STL of the model; OpenSCAD models render upright with their job's overrides. */
export function meshFor(modelId: string): Promise<string> {
  const model = getModel(modelId);
  if (!model.file) throw Object.assign(new Error(`${modelId} has no mesh`), { statusCode: 404 });
  const src = path.join(ROOT, model.file);
  if (src.endsWith(".stl")) return Promise.resolve(src);

  const job = model.jobs[0] ? getJob(model.jobs[0].name) : null;
  const params = job?.scad ?? {};
  const dest = path.join(CACHE, `${modelId}.stl`);
  const stamp = path.join(CACHE, `${modelId}.stl.key`);
  const key = JSON.stringify({ mtime: fs.statSync(src).mtimeMs, params });
  if (fs.existsSync(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === key)
    return Promise.resolve(dest);

  if (!inflight.has(modelId)) {
    const work = (async () => {
      const tmp = dest + ".tmp.stl";
      if (src.endsWith(".scad")) {
        const defs = Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]);
        await run(OPENSCAD, ["-D", "upright=true", ...defs, "-o", tmp, src], { maxBuffer: 1 << 24 });
      } else {
        threemfToStl(src, tmp);
      }
      fs.renameSync(tmp, dest);
      fs.writeFileSync(stamp, key);
      return dest;
    })().finally(() => inflight.delete(modelId));
    inflight.set(modelId, work);
  }
  return inflight.get(modelId)!;
}
