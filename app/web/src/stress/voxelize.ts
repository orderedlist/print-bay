// Voxelize a closed triangle mesh (non-indexed positions, 9 floats per triangle)
// into a regular grid of solid cubes for the stress solve.
//
// Inside test: for every (x, y) column, cast a ray along Z and record where it
// crosses the surface; voxels between alternate crossings are inside (parity).
// Voxels that a surface passes through are kept too, so thin walls survive
// even when they're thinner than one voxel.

export interface Grid {
  pitch: number;
  origin: [number, number, number]; // min corner
  dims: [number, number, number];   // voxels per axis
  solid: Uint8Array;                // nx*ny*nz, index = i + nx*(j + ny*k)
  count: number;
}

export function meshVolume(pos: Float32Array): number {
  let v = 0;
  for (let t = 0; t < pos.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(t, t + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v) / 6;
}

/** About 15k voxels, but never finer than 0.8 mm or coarser than 3 mm. */
export function defaultPitch(pos: Float32Array): number {
  return Math.min(3, Math.max(0.8, Math.cbrt(meshVolume(pos) / 15000)));
}

export function voxelize(pos: Float32Array, pitch = defaultPitch(pos)): Grid {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], pos[i + a]);
      max[a] = Math.max(max[a], pos[i + a]);
    }
  }
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / pitch - 1e-9))) as [number, number, number];
  const [nx, ny, nz] = dims;
  const solid = new Uint8Array(nx * ny * nz);
  const columns: number[][] = Array.from({ length: nx * ny }, () => []);

  // a tiny offset keeps column rays off shared triangle edges and vertices
  const ox = pitch * 1.3e-4, oy = pitch * 2.7e-4;
  for (let t = 0; t < pos.length; t += 9) {
    const ax = pos[t], ay = pos[t + 1], az = pos[t + 2];
    const bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5];
    const cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue; // vertical triangle: no column crosses it
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - min[0]) / pitch - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - min[0]) / pitch - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - min[1]) / pitch - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - min[1]) / pitch - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = min[1] + (j + 0.5) * pitch + oy;
      for (let i = i0; i <= i1; i++) {
        const px = min[0] + (i + 0.5) * pitch + ox;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        columns[i + nx * j].push(l1 * az + l2 * bz + l3 * cz);
      }
    }
  }

  for (let c = 0; c < columns.length; c++) {
    const zs = columns[c].sort((a, b) => a - b);
    for (let p = 0; p + 1 < zs.length; p += 2) {
      const k0 = Math.max(0, Math.ceil((zs[p] - min[2]) / pitch - 0.5));
      const k1 = Math.min(nz - 1, Math.floor((zs[p + 1] - min[2]) / pitch - 0.5));
      for (let k = k0; k <= k1; k++) solid[c + nx * ny * k] = 1;
    }
  }

  // surface voxels: sample each triangle at half-pitch spacing
  const step = pitch / 2;
  const mark = (x: number, y: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - min[0]) / pitch)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((y - min[1]) / pitch)));
    const k = Math.min(nz - 1, Math.max(0, Math.floor((z - min[2]) / pitch)));
    solid[i + nx * (j + ny * k)] = 1;
  };
  for (let t = 0; t < pos.length; t += 9) {
    const a = [pos[t], pos[t + 1], pos[t + 2]], b = [pos[t + 3], pos[t + 4], pos[t + 5]], c = [pos[t + 6], pos[t + 7], pos[t + 8]];
    const n = Math.max(1, Math.ceil(Math.max(dist(a, b), dist(b, c), dist(c, a)) / step));
    for (let u = 0; u <= n; u++) {
      for (let v = 0; v <= n - u; v++) {
        const s = u / n, r = v / n, q = 1 - s - r;
        mark(q * a[0] + s * b[0] + r * c[0], q * a[1] + s * b[1] + r * c[1], q * a[2] + s * b[2] + r * c[2]);
      }
    }
  }

  let count = 0;
  for (let i = 0; i < solid.length; i++) count += solid[i];
  return { pitch, origin: [min[0], min[1], min[2]], dims, solid, count };
}

function dist(a: number[], b: number[]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
