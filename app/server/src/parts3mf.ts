// Pack separately rendered parts into one OrcaSlicer object, one filament per part
// (ported from scripts/parts3mf.py, which the terminal scripts still use).
//
// OrcaSlicer only gives different parts different filaments when they are parts
// (volumes) of a single object, which is how its own 3MF projects store them: each
// part is a mesh object, a parent object lists them as components, and
// Metadata/model_settings.config gives each part its extruder. The parts keep their
// rendered coordinates relative to each other; the whole object goes to the middle
// of the bed.
import fs from "node:fs";
import { strToU8, zipSync } from "fflate";

export const BED = 260; // mm, the K2's printable area is 0..260 in X and Y
const MARGIN = 4; // mm kept clear at the bed's edges
const GAP = 4; // mm between copies
export const TOWER: [number, number] = [190, 190]; // prime tower corner (multi-colour): this back-right square stays free

type Vec = [number, number, number];

/** Centres of as many w x d footprints as fit on the bed, nearest the middle first. */
export function grid(w: number, d: number, tower = false, limit?: number): [number, number][] {
  const cols = Math.floor((BED - 2 * MARGIN + GAP) / (w + GAP));
  const rows = Math.floor((BED - 2 * MARGIN + GAP) / (d + GAP));
  const x0 = BED / 2 - (cols * (w + GAP) - GAP) / 2 + w / 2;
  const y0 = BED / 2 - (rows * (d + GAP) - GAP) / 2 + d / 2;
  let spots: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) spots.push([x0 + c * (w + GAP), y0 + r * (d + GAP)]);
  if (tower) spots = spots.filter(([x, y]) => x + w / 2 < TOWER[0] || y + d / 2 < TOWER[1]);
  const dist = ([x, y]: [number, number]) => Math.round((Math.abs(y - BED / 2) + Math.abs(x - BED / 2)) * 1000) / 1000;
  spots.sort((a, b) => dist(a) - dist(b) || a[1] - b[1] || a[0] - b[0]);
  return limit ? spots.slice(0, limit) : spots;
}

/** Vertices and triangles of a binary or ASCII STL, with shared vertices merged. */
export function readStl(file: string): { verts: Vec[]; tris: [number, number, number][] } {
  const data = fs.readFileSync(file);
  const corners: Vec[] = [];
  if (data.subarray(0, 5).toString() === "solid" && data.subarray(0, 1024).includes("facet")) {
    for (const line of data.toString("utf8").split("\n")) {
      const p = line.trim().split(/\s+/);
      if (p[0] === "vertex") corners.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    }
  } else {
    const n = data.readUInt32LE(80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 3; k++) corners.push([data.readFloatLE(o + 12 * k), data.readFloatLE(o + 12 * k + 4), data.readFloatLE(o + 12 * k + 8)]);
    }
  }
  const index = new Map<string, number>();
  const verts: Vec[] = [];
  const tris: [number, number, number][] = [];
  for (let i = 0; i + 2 < corners.length; i += 3) {
    const tri = corners.slice(i, i + 3).map((v) => {
      const r = v.map((c) => Math.round(c * 1e5) / 1e5) as Vec;
      const key = r.join(",");
      let at = index.get(key);
      if (at === undefined) { at = verts.length; index.set(key, at); verts.push(r); }
      return at;
    });
    if (new Set(tri).size === 3) tris.push(tri as [number, number, number]);
  }
  return { verts, tris };
}

function meshXml(verts: Vec[], tris: [number, number, number][], dx: number, dy: number, dz: number): string {
  let v = "", t = "";
  for (const [x, y, z] of verts) v += `<vertex x="${(x + dx).toFixed(5)}" y="${(y + dy).toFixed(5)}" z="${(z + dz).toFixed(5)}"/>`;
  for (const [a, b, c] of tris) t += `<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
  return `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh>`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * parts: [part name, STL path, extruder number from 1] -> a 3MF at dest.
 * `copies` > 1 lays that many on the bed in a grid, as objects sharing the part meshes.
 */
export function write(parts: [string, string, number][], dest: string, name = "model", copies = 1): string {
  const meshes = parts.map(([pname, stl, extruder]) => ({ pname, extruder, ...readStl(stl) }));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (const v of m.verts) for (let k = 0; k < 3; k++) {
    if (v[k] < lo[k]) lo[k] = v[k];
    if (v[k] > hi[k]) hi[k] = v[k];
  }
  if (lo[0] === Infinity) throw new Error("The model rendered empty: nothing to slice.");
  // centre the parts as a group on the origin, sitting on z = 0; the build item moves it to the bed
  const [dx, dy, dz] = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];

  let spots: [number, number][] = [[BED / 2, BED / 2]];
  if (copies > 1) {
    spots = grid(hi[0] - lo[0], hi[1] - lo[1], meshes.length > 1, copies);
    if (spots.length < copies) throw new Error(`Only ${spots.length} fit on the bed, not ${copies}.`);
  }
  // Each copy is its own object made of the shared part meshes: Orca applies per-part
  // filaments to an object, not to extra instances of it.
  const first = meshes.length + 1;
  const parents = spots.map((_, i) => first + i);
  let objects = meshes.map((m, i) => `<object id="${i + 1}" type="model">${meshXml(m.verts, m.tris, dx, dy, dz)}</object>`).join("");
  const components = meshes.map((_, i) => `<component objectid="${i + 1}"/>`).join("");
  objects += parents.map((p) => `<object id="${p}" type="model"><components>${components}</components></object>`).join("");
  const items = parents.map((p, i) =>
    `<item objectid="${p}" transform="1 0 0 0 1 0 0 0 1 ${spots[i][0].toFixed(3)} ${spots[i][1].toFixed(3)} 0" printable="1"/>`).join("");
  const model = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources>${objects}</resources><build>${items}</build></model>`;
  const partSettings = meshes.map((m, i) =>
    `<part id="${i + 1}" subtype="normal_part"><metadata key="name" value="${esc(m.pname)}"/>`
    + `<metadata key="extruder" value="${m.extruder}"/></part>`).join("");
  const settings = '<?xml version="1.0" encoding="UTF-8"?><config>'
    + parents.map((p, k) => `<object id="${p}"><metadata key="name" value="${esc(name)}${spots.length > 1 ? ` ${k + 1}` : ""}"/>`
      + `<metadata key="extruder" value="${meshes[0].extruder}"/>${partSettings}</object>`).join("")
    + "</config>";
  fs.writeFileSync(dest, zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    "3D/3dmodel.model": strToU8(model),
    "Metadata/model_settings.config": strToU8(settings),
  }));
  return dest;
}
