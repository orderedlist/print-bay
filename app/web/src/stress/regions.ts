// Faces on a triangle mesh: grow a clicked triangle into the flat-ish surface
// around it (neighbors across shared edges whose normal stays within ~18 degrees
// of the first one). Used to pick where a load presses and what holds a part.

export interface Region {
  triangles: number[];
  normal: [number, number, number]; // area-weighted average
  area: number;
  centroid: [number, number, number];
}

export interface Surface {
  pos: Float32Array;
  normals: Float32Array; // per triangle, unit
  areas: Float32Array;
  neighbors: Int32Array[]; // per triangle, triangles across its edges
}

const COS_LIMIT = 0.95;

export function surface(pos: Float32Array): Surface {
  const nTri = pos.length / 9;
  const normals = new Float32Array(nTri * 3), areas = new Float32Array(nTri);
  const key = (v: number) => `${Math.round(pos[v] * 1e3)},${Math.round(pos[v + 1] * 1e3)},${Math.round(pos[v + 2] * 1e3)}`;
  const vertexId = new Map<string, number>();
  const ids = new Int32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) {
      const k = key(t * 9 + c * 3);
      let id = vertexId.get(k);
      if (id === undefined) { id = vertexId.size; vertexId.set(k, id); }
      ids[t * 3 + c] = id;
    }
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len;
    areas[t] = len / 2;
  }
  const edges = new Map<string, number[]>();
  for (let t = 0; t < nTri; t++) for (let c = 0; c < 3; c++) {
    const a = ids[t * 3 + c], b = ids[t * 3 + ((c + 1) % 3)];
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    let list = edges.get(k);
    if (!list) edges.set(k, (list = []));
    list.push(t);
  }
  const lists: number[][] = Array.from({ length: nTri }, () => []);
  for (const tris of edges.values()) for (const a of tris) for (const b of tris) if (a !== b) lists[a].push(b);
  return { pos, normals, areas, neighbors: lists.map((l) => Int32Array.from(l)) };
}

export function growRegion(s: Surface, seed: number, taken?: Uint8Array): Region {
  const n0 = [s.normals[seed * 3], s.normals[seed * 3 + 1], s.normals[seed * 3 + 2]];
  const seen = new Set<number>([seed]);
  const queue = [seed];
  for (let q = 0; q < queue.length; q++) {
    for (const t of s.neighbors[queue[q]]) {
      if (seen.has(t) || taken?.[t]) continue;
      const dot = s.normals[t * 3] * n0[0] + s.normals[t * 3 + 1] * n0[1] + s.normals[t * 3 + 2] * n0[2];
      if (dot < COS_LIMIT) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return summarize(s, queue);
}

function summarize(s: Surface, triangles: number[]): Region {
  let area = 0;
  const n = [0, 0, 0], c = [0, 0, 0];
  for (const t of triangles) {
    const a = s.areas[t];
    area += a;
    for (let k = 0; k < 3; k++) {
      n[k] += s.normals[t * 3 + k] * a;
      c[k] += ((s.pos[t * 9 + k] + s.pos[t * 9 + 3 + k] + s.pos[t * 9 + 6 + k]) / 3) * a;
    }
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return {
    triangles, area,
    normal: [n[0] / len, n[1] / len, n[2] / len],
    centroid: [c[0] / (area || 1), c[1] / (area || 1), c[2] / (area || 1)],
  };
}

/** Split the whole surface into regions, largest first. */
export function partition(s: Surface): Region[] {
  const nTri = s.areas.length;
  const taken = new Uint8Array(nTri);
  const regions: Region[] = [];
  for (let t = 0; t < nTri; t++) {
    if (taken[t]) continue;
    const r = growRegion(s, t, taken);
    for (const x of r.triangles) taken[x] = 1;
    regions.push(r);
  }
  return regions.sort((a, b) => b.area - a.area);
}

/** With nothing picked: hold the biggest face that doesn't point up, load the biggest that does. */
export function autoAim(s: Surface): { hold: Region; load: Region } | null {
  const regions = partition(s);
  const hold = regions.find((r) => r.normal[2] <= 0.7);
  const load = regions.find((r) => r.normal[2] > 0.7);
  return hold && load ? { hold, load } : null;
}

export function trianglesOf(s: Surface, r: Region): Float32Array {
  const out = new Float32Array(r.triangles.length * 9);
  r.triangles.forEach((t, i) => out.set(s.pos.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}
