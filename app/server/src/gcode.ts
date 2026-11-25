// Toolpaths from sliced G-code, for the x-ray view (ported from scripts/view.py).
//
// Binary format: uint32 header length, JSON header ({layers, types: [{name, offset,
// count, layerStarts}]}) padded to 4 bytes, then float32 segments (x0,y0,z,x1,y1,z)
// grouped by feature type, each type's segments in layer order.
import fs from "node:fs";
import path from "node:path";
import { CACHE } from "./config.js";
import { gcodePath, type Material } from "./jobs.js";
import type { Nozzle } from "./nozzle.js";

const AXIS = /([XYZE])(-?[\d.]+)/g;

function parse(text: string) {
  const segs = new Map<string, number[]>();
  const layerOf = new Map<string, number[]>();
  const layers: number[] = [];
  let x = 0, y = 0, z = 0, eAbs = 0, layer = -1, kind = "Custom", relative = true;

  for (const line of text.split("\n")) {
    const c = line.charCodeAt(0);
    if (c === 59 /* ; */) {
      if (line.startsWith(";TYPE:")) kind = line.slice(6).trim();
      else if (line.startsWith(";LAYER_CHANGE")) layer++;
      else if (line.startsWith(";Z:")) {
        z = Number(line.slice(3));
        if (layer >= 0) layers[layer] = z;
      }
      continue;
    }
    if (line.startsWith("M83")) relative = true;
    else if (line.startsWith("M82")) relative = false;
    else if (line.startsWith("G92") && line.includes("E")) eAbs = 0;
    else if (c === 71 /* G */ && /^G[0-3]\b/.test(line)) {
      let nx = x, ny = y, e: number | null = null;
      for (const [, axis, val] of line.split(";")[0].matchAll(AXIS)) {
        if (axis === "X") nx = Number(val);
        else if (axis === "Y") ny = Number(val);
        else if (axis === "Z") z = Number(val);
        else e = Number(val);
      }
      let de = 0;
      if (e !== null) {
        de = relative ? e : e - eAbs;
        if (!relative) eAbs = e;
      }
      if (de > 0 && (nx !== x || ny !== y) && layer >= 0) {
        if (!segs.has(kind)) { segs.set(kind, []); layerOf.set(kind, []); }
        segs.get(kind)!.push(x, y, z, nx, ny, z);
        layerOf.get(kind)!.push(layer);
      }
      x = nx; y = ny;
    }
  }
  return { segs, layerOf, layers };
}

/** The toolpaths of one of a job's slices: n to a plate, for a material, all on one spool (see gcodePath). */
export function toolpathsFor(job: string, perPlate = 1, material: Material = "pla", oneColor = false, nozzle?: Nozzle): Buffer | null {
  const gcode = gcodePath(job, perPlate, material, nozzle, oneColor);
  if (!fs.existsSync(gcode)) return null;
  const dest = path.join(CACHE, `${path.basename(gcode, ".gcode")}.paths`); // per G-code file: one per nozzle
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(gcode).mtimeMs) return fs.readFileSync(dest);

  const { segs, layerOf, layers } = parse(fs.readFileSync(gcode, "utf8"));
  const types: { name: string; offset: number; count: number; layerStarts: number[] }[] = [];
  const chunks: Float32Array[] = [];
  let offset = 0;
  for (const [name, pts] of segs) {
    const count = pts.length / 6;
    const lo = layerOf.get(name)!;
    const layerStarts: number[] = [];
    let i = 0;
    for (let n = 0; n <= layers.length; n++) { // first segment at or after each layer
      while (i < count && lo[i] < n) i++;
      layerStarts.push(i);
    }
    types.push({ name, offset, count, layerStarts });
    chunks.push(Float32Array.from(pts));
    offset += count;
  }
  let header = Buffer.from(JSON.stringify({ layers, types }));
  header = Buffer.concat([header, Buffer.alloc((4 - (header.length % 4)) % 4, 32)]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const body = Buffer.concat([len, header, ...chunks.map((c) => Buffer.from(c.buffer))]);
  fs.writeFileSync(dest, body);
  return body;
}
