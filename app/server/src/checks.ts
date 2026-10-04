// Printability checks on the print-orientation mesh (what gets sliced).
// Coordinates are centered on the bed like the viewer shows them: x/y centered,
// lowest point at z = 0.
import fs from "node:fs";

export type Severity = "fail" | "warn" | "info";
export interface Finding {
  rule: string;
  severity: Severity;
  message: string; // plain language
  detail: string;  // numbers
  at: [number, number, number];
}
export interface CheckReport { findings: Finding[]; size: [number, number, number]; triangles: number }

const BED = { x: 260, y: 260, z: 260 };
const OVERHANG_COS = Math.cos((45 * Math.PI) / 180); // downward normal steeper than this from vertical
const BRIDGE_MAX = 30;    // mm
const MIN_WALL = 1.0;     // mm
const WARP_AREA = 20000;  // mm^2 x shrink ratio
const PLA_SHRINK = 0.3;

export function readStl(file: string): Float32Array {
  return readStlParts(file).pos;
}

/**
 * Triangles of an STL, plus which part each belongs to: multi-colour meshes from
 * mesh.ts carry the part number (1, 2, ...) in each triangle's attribute bytes.
 */
export function readStlParts(file: string): { pos: Float32Array; part: Uint16Array | null } {
  const buf = fs.readFileSync(file);
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  if (84 + n * 50 === buf.length) {
    const pos = new Float32Array(n * 9);
    const part = new Uint16Array(n);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 9; k++) pos[t * 9 + k] = buf.readFloatLE(84 + t * 50 + 12 + k * 4);
      part[t] = buf.readUInt16LE(84 + t * 50 + 48);
    }
    return { pos, part: part.some((p) => p > 1) ? part : null };
  }
  const nums = [...buf.toString("utf8").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
  return { pos: Float32Array.from(nums), part: null };
}

function center(pos: Float32Array): [number, number, number] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], pos[i + a]); max[a] = Math.max(max[a], pos[i + a]);
  }
  const off = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) pos[i + a] -= off[a];
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

interface Tri { n: [number, number, number]; area: number; c: [number, number, number]; zmin: number; lo: number[]; hi: number[] }

function triangles(pos: Float32Array): Tri[] {
  const out: Tri[] = [];
  for (let o = 0; o < pos.length; o += 9) {
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.push({
      n: [nx / len, ny / len, nz / len], area: len / 2,
      c: [(pos[o] + pos[o + 3] + pos[o + 6]) / 3, (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3, (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3],
      zmin: Math.min(pos[o + 2], pos[o + 5], pos[o + 8]),
      lo: [0, 1, 2].map((a) => Math.min(pos[o + a], pos[o + 3 + a], pos[o + 6 + a])),
      hi: [0, 1, 2].map((a) => Math.max(pos[o + a], pos[o + 3 + a], pos[o + 6 + a])),
    });
  }
  return out;
}

/** Triangles across each shared edge. */
function adjacency(pos: Float32Array): number[][] {
  const key = (i: number) => `${Math.round(pos[i] * 1e3)},${Math.round(pos[i + 1] * 1e3)},${Math.round(pos[i + 2] * 1e3)}`;
  const edges = new Map<string, number[]>();
  const nTri = pos.length / 9;
  for (let t = 0; t < nTri; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let c = 0; c < 3; c++) {
      const a = k[c], b = k[(c + 1) % 3];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      let l = edges.get(e);
      if (!l) edges.set(e, (l = []));
      l.push(t);
    }
  }
  const adj: number[][] = Array.from({ length: nTri }, () => []);
  for (const l of edges.values()) for (const a of l) for (const b of l) if (a !== b) adj[a].push(b);
  return adj;
}

function components(adj: number[][], keep: (t: number) => boolean = () => true): number[][] {
  const seen = new Uint8Array(adj.length);
  const out: number[][] = [];
  for (let s = 0; s < adj.length; s++) {
    if (seen[s] || !keep(s)) continue;
    const comp = [s];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) for (const t of adj[comp[q]]) if (!seen[t] && keep(t)) { seen[t] = 1; comp.push(t); }
    out.push(comp);
  }
  return out;
}

const weighted = (tris: Tri[], ids: number[]): [number, number, number] => {
  let a = 0; const c = [0, 0, 0];
  for (const t of ids) { a += tris[t].area; for (let k = 0; k < 3; k++) c[k] += tris[t].c[k] * tris[t].area; }
  return [c[0] / (a || 1), c[1] / (a || 1), c[2] / (a || 1)];
};
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---- ray casting for wall thickness: a uniform grid over triangle bounds ----

class RayGrid {
  cell: number; min: number[]; dims: number[]; cells: Map<number, number[]> = new Map();
  constructor(private pos: Float32Array, cell: number) {
    this.cell = cell;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[i + a]); max[a] = Math.max(max[a], pos[i + a]); }
    this.min = min;
    this.dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell) + 1));
    for (let t = 0; t < pos.length / 9; t++) {
      const lo = [0, 1, 2].map((a) => Math.floor((Math.min(pos[t * 9 + a], pos[t * 9 + 3 + a], pos[t * 9 + 6 + a]) - min[a]) / cell));
      const hi = [0, 1, 2].map((a) => Math.floor((Math.max(pos[t * 9 + a], pos[t * 9 + 3 + a], pos[t * 9 + 6 + a]) - min[a]) / cell));
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const id = i + this.dims[0] * (j + this.dims[1] * k);
        let l = this.cells.get(id);
        if (!l) this.cells.set(id, (l = []));
        l.push(t);
      }
    }
  }
  /** Distance to the first triangle the ray exits through (normal along the ray), up to maxDist. */
  exitDistance(o: number[], d: number[], maxDist: number, normals: Tri[], skip: number): number {
    const seen = new Set<number>([skip]);
    let best = Infinity;
    const steps = Math.ceil(maxDist / (this.cell / 2));
    for (let s = 0; s <= steps; s++) {
      const p = [0, 1, 2].map((a) => o[a] + d[a] * s * (this.cell / 2));
      const idx = [0, 1, 2].map((a) => Math.floor((p[a] - this.min[a]) / this.cell));
      if (idx.some((v, a) => v < 0 || v >= this.dims[a])) break;
      for (const t of this.cells.get(idx[0] + this.dims[0] * (idx[1] + this.dims[1] * idx[2])) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        const n = normals[t].n;
        if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0.3) continue; // only surfaces we'd exit through
        const hit = intersect(this.pos, t, o, d);
        if (hit > 1e-4 && hit < best) best = hit;
      }
      if (best < s * (this.cell / 2) - this.cell) break;
    }
    return best;
  }
}

function intersect(pos: Float32Array, t: number, o: number[], d: number[]): number {
  const a = pos.subarray(t * 9, t * 9 + 3), b = pos.subarray(t * 9 + 3, t * 9 + 6), c = pos.subarray(t * 9 + 6, t * 9 + 9);
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
}

// ---- multi-colour parts ----

function boxOf(tris: Tri[], list: number[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of list) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], tris[t].lo[a]); max[a] = Math.max(max[a], tris[t].hi[a]);
  }
  return { min, max };
}

/** The part with the most surface: the body the other colours are set into. */
function biggestPart(tris: Tri[], part: Uint16Array): number {
  const area = new Map<number, number>();
  part.forEach((p, t) => area.set(p, (area.get(p) ?? 0) + tris[t].area));
  return [...area].sort((a, b) => b[1] - a[1])[0][0];
}

/** Bounding box of each colour part. */
function partBoxes(tris: Tri[], part: Uint16Array) {
  const by = new Map<number, number[]>();
  part.forEach((p, t) => { if (!by.has(p)) by.set(p, []); by.get(p)!.push(t); });
  return [...by].map(([p, list]) => ({ part: p, ...boxOf(tris, list) }));
}

/** Merge bodies whose bounds touch: separate colour shells that print fused. */
function touching(bodies: number[][], tris: Tri[]): number[][] {
  const boxes = bodies.map((b) => boxOf(tris, b));
  const root = bodies.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const near = (a: typeof boxes[0], b: typeof boxes[0]) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + 0.3 && b.min[k] <= a.max[k] + 0.3);
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) if (near(boxes[i], boxes[j])) root[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  bodies.forEach((b, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), ...b]); });
  return [...groups.values()];
}

// ---- the checks ----

/**
 * `part` (per triangle, from 1) marks a multi-colour model: the biggest part is the
 * body, the others are colour set into it. They print fused, so parts that touch
 * count as one piece, and a colour inlay is skin-deep, not a wall.
 */
export function check(pos: Float32Array, opts: { supports?: boolean; part?: Uint16Array | null } = {}): CheckReport {
  const size = center(pos);
  const tris = triangles(pos);
  const adj = adjacency(pos);
  const findings: Finding[] = [];
  const part = opts.part ?? null;
  const body = part ? biggestPart(tris, part) : 0;

  // solids: more than one body means something came apart
  const bodies = (part ? touching(components(adj), tris) : components(adj)).sort((a, b) => b.length - a.length);
  if (bodies.length > 1) {
    const stray = bodies[bodies.length - 1];
    findings.push({ rule: "solids", severity: "fail", at: weighted(tris, stray),
      message: `The model is ${bodies.length} separate pieces; one has come loose from the rest.`,
      detail: `${bodies.length} bodies; smallest has ${stray.length} triangles` });
  }

  // build volume
  if (size[0] > BED.x || size[1] > BED.y || size[2] > BED.z) {
    findings.push({ rule: "build_volume", severity: "fail", at: [0, 0, size[2] / 2],
      message: "It doesn't fit the K2's build volume as laid out.",
      detail: `${size.map((s) => round(s)).join(" x ")} mm vs ${BED.x} x ${BED.y} x ${BED.z}` });
  }

  // overhangs: downward faces steeper than 45 degrees that aren't on the bed
  // (in a multi-colour model, a face resting on another colour's part is held up by it)
  const others = part ? partBoxes(tris, part) : [];
  const restsOnPart = (t: number) => others.some((b) => b.part !== part![t] && tris[t].zmin <= b.max[2] + 0.3 &&
    tris[t].c[0] >= b.min[0] - 0.3 && tris[t].c[0] <= b.max[0] + 0.3 && tris[t].c[1] >= b.min[1] - 0.3 && tris[t].c[1] <= b.max[1] + 0.3);
  const down = (t: number) => tris[t].n[2] < -OVERHANG_COS && tris[t].zmin > 0.3 && !(part && restsOnPart(t));
  let supported = 0, supportedArea = 0, supportedAt: [number, number, number] = [0, 0, 0], biggest = 0;
  for (const region of components(adj, down)) {
    const area = region.reduce((s, t) => s + tris[t].area, 0);
    if (area < 4) continue; // tiny ledges print fine
    const xs = region.map((t) => tris[t].c[0]), ys = region.map((t) => tris[t].c[1]);
    const span = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const flat = region.every((t) => tris[t].n[2] < -0.97);
    const at = weighted(tris, region);
    if (flat && span <= BRIDGE_MAX) continue; // a short bridge
    if (opts.supports) {
      supported++; supportedArea += area;
      if (area > biggest) { biggest = area; supportedAt = at; }
      continue;
    }
    const severity: Severity = opts.supports ? "info" : flat ? "warn" : "fail";
    findings.push(flat
      ? { rule: "overhang", severity, at, message: opts.supports ? "Supports will print under this ceiling." : `A flat ceiling spans about ${round(span, 0)} mm, longer than a clean bridge.`,
          detail: `bridge ${round(span)} mm > ${BRIDGE_MAX} mm, ${round(area, 0)} mm^2` }
      : { rule: "overhang", severity, at, message: opts.supports ? "Supports will print under this overhang." : "This surface overhangs more than 45 degrees and will sag without supports.",
          detail: `${round(area, 0)} mm^2 below 45 deg at z ${round(at[2])}` });
  }

  if (supported) {
    findings.push({ rule: "overhang", severity: "info", at: supportedAt,
      message: `Supports are on and will print under ${supported} overhang${supported > 1 ? "s" : ""}.`,
      detail: `${supported} regions, ${round(supportedArea, 0)} mm^2 total; largest ${round(biggest, 0)} mm^2` });
  }

  // thin walls: cast inward from face samples, look for the far side
  const grid = new RayGrid(pos, Math.max(2, Math.cbrt((size[0] * size[1] * size[2]) / 20000)));
  const order = tris.map((_, i) => i).filter((t) => !part || part[t] === body) // colour inlays are skin-deep
    .sort((a, b) => tris[b].area - tris[a].area).slice(0, 4000);
  let thinnest = Infinity, thinAt: [number, number, number] = [0, 0, 0], thinCount = 0, thinArea = 0;
  for (const t of order) {
    const { n, c } = tris[t];
    const d = [-n[0], -n[1], -n[2]];
    const o = [c[0] + d[0] * 1e-3, c[1] + d[1] * 1e-3, c[2] + d[2] * 1e-3];
    const w = grid.exitDistance(o, d, MIN_WALL * 3, tris, t);
    if (w < MIN_WALL * 0.97) { thinCount++; thinArea += tris[t].area; if (w < thinnest) { thinnest = w; thinAt = c; } }
  }
  if (thinCount) {
    // a few spots (a tapered tip, a knife edge) are a warning; a real thin wall fails
    const widespread = thinArea > 20 && thinnest < 0.6;
    findings.push({ rule: "min_wall", severity: widespread ? "fail" : "warn", at: thinAt,
      message: widespread
        ? `Walls thinner than ${MIN_WALL} mm (down to about ${round(thinnest, 2)} mm) may print weak or not at all.`
        : `A small area tapers below ${MIN_WALL} mm (about ${round(thinnest, 2)} mm), like a knife edge or pointed tip.`,
      detail: `${thinCount} samples under ${MIN_WALL} mm over ${round(thinArea, 0)} mm^2, min ${round(thinnest, 2)} mm` });
  }

  // warping: a big first layer pulls its corners up as it cools
  const firstLayer = tris.filter((t) => t.n[2] < -0.99 && t.zmin < 0.2).reduce((s, t) => s + t.area, 0);
  if (firstLayer * PLA_SHRINK > WARP_AREA) {
    findings.push({ rule: "warp_risk", severity: "warn", at: [0, 0, 0],
      message: "The first layer is large enough that its corners may lift. Rounded corners or a brim help.",
      detail: `first layer ${round(firstLayer, 0)} mm^2` });
  }
  if (firstLayer < 1) {
    findings.push({ rule: "bed_contact", severity: "fail", at: [0, 0, 0],
      message: "Nothing sits flat on the bed; it needs a flat face down.", detail: "no downward faces at z = 0" });
  }

  // stability: center of mass over the footprint
  let vol = 0; const com = [0, 0, 0];
  for (let o = 0; o < pos.length; o += 9) {
    const a = pos.subarray(o, o + 3), b = pos.subarray(o + 3, o + 6), c = pos.subarray(o + 6, o + 9);
    const v = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    vol += v;
    for (let k = 0; k < 3; k++) com[k] += (v * (a[k] + b[k] + c[k])) / 4;
  }
  if (vol) for (let k = 0; k < 3; k++) com[k] /= vol;
  const feet = tris.filter((t) => t.n[2] < -0.99 && t.zmin < 0.2);
  if (feet.length) {
    const fx = feet.map((t) => t.c[0]), fy = feet.map((t) => t.c[1]);
    const inside = com[0] >= Math.min(...fx) - 1 && com[0] <= Math.max(...fx) + 1 && com[1] >= Math.min(...fy) - 1 && com[1] <= Math.max(...fy) + 1;
    if (!inside) findings.push({ rule: "stability", severity: "warn", at: [com[0], com[1], com[2]],
      message: "Its center of mass is outside what sits on the bed, so it may tip over while printing.",
      detail: `center of mass ${com.map((v) => round(v)).join(", ")}` });
  }

  const order2: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order2[a.severity] - order2[b.severity]);
  return { findings, size: size.map((s) => round(s, 2)) as [number, number, number], triangles: tris.length };
}
