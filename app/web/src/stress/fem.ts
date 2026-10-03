// Linear-elastic stress on a voxel grid: every solid voxel is an 8-node hex
// element, all with the same stiffness (one 24x24 matrix, scaled by E and the
// voxel size). The system is stored as 3x3 blocks per node pair and solved with
// Jacobi-preconditioned conjugate gradients.
import type { Grid } from "./voxelize.ts";

export interface Material { name: string; E: number; yield: number; layer: number }

// MPa. "layer" is the tensile strength across layer lines, about half the
// in-plane strength: where FDM parts actually break.
export const MATERIALS: Material[] = [
  { name: "PLA", E: 3500, yield: 50, layer: 25 },
  { name: "PETG", E: 2100, yield: 47, layer: 30 },
  { name: "ABS", E: 2200, yield: 40, layer: 18 },
  { name: "ASA", E: 2400, yield: 43, layer: 20 },
  { name: "Nylon", E: 1700, yield: 45, layer: 30 },
  { name: "PC", E: 2300, yield: 60, layer: 30 },
];
const NU = 0.35;

export interface Problem {
  material: Material;
  holds: Float32Array[]; // triangles (9 floats each) of each face that holds the part
  load: Float32Array;    // triangles of the face the weight presses on
  forceN: number;        // straight down (-Z)
}

export interface Solution {
  vonMises: Float32Array;  // per grid voxel (0 where empty), MPa
  principal: Float32Array; // max principal stress per voxel, MPa (tension > 0)
  peakVonMises: number;
  peakTension: number;
  hotspot: [number, number, number];
  sagMm: number;
  iterations: number;
  converged: boolean;
  fixedNodes: number;
  loadNodes: number;
}

// ---- element stiffness ----

const LOCAL = Array.from({ length: 8 }, (_, a) => [a & 1, (a >> 1) & 1, (a >> 2) & 1]); // node (di, dj, dk)

function constitutive(E: number, nu: number): number[][] {
  const l = (E * nu) / ((1 + nu) * (1 - 2 * nu)), m = E / (2 * (1 + nu));
  return [
    [l + 2 * m, l, l, 0, 0, 0], [l, l + 2 * m, l, 0, 0, 0], [l, l, l + 2 * m, 0, 0, 0],
    [0, 0, 0, m, 0, 0], [0, 0, 0, 0, m, 0], [0, 0, 0, 0, 0, m],
  ];
}

/** Strain-displacement matrix (6x24) at natural coords, for a unit cube. */
function bMatrix(xi: number, eta: number, zeta: number): number[][] {
  const B = Array.from({ length: 6 }, () => new Array(24).fill(0));
  LOCAL.forEach(([di, dj, dk], a) => {
    const sx = 2 * di - 1, sy = 2 * dj - 1, sz = 2 * dk - 1;
    // dN/dx = dN/dxi * dxi/dx, with dxi/dx = 2 for a unit cube
    const dx = (2 * sx * (1 + sy * eta) * (1 + sz * zeta)) / 8;
    const dy = (2 * sy * (1 + sx * xi) * (1 + sz * zeta)) / 8;
    const dz = (2 * sz * (1 + sx * xi) * (1 + sy * eta)) / 8;
    const c = 3 * a;
    B[0][c] = dx; B[1][c + 1] = dy; B[2][c + 2] = dz;
    B[3][c] = dy; B[3][c + 1] = dx;     // gamma_xy
    B[4][c + 1] = dz; B[4][c + 2] = dy; // gamma_yz
    B[5][c] = dz; B[5][c + 2] = dx;     // gamma_zx
  });
  return B;
}

/** Ke for E = 1 and a unit cube; scales with E * h. 2x2x2 Gauss quadrature. */
const KE1: Float64Array = (() => {
  const D = constitutive(1, NU);
  const K = new Float64Array(24 * 24);
  const g = 1 / Math.sqrt(3);
  const detJ = 1 / 8; // (h/2)^3 for h = 1
  for (const xi of [-g, g]) for (const eta of [-g, g]) for (const zeta of [-g, g]) {
    const B = bMatrix(xi, eta, zeta);
    const DB = D.map((row) => Array.from({ length: 24 }, (_, j) => row.reduce((s, d, k) => s + d * B[k][j], 0)));
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += B[k][i] * DB[k][j];
      K[i * 24 + j] += s * detJ;
    }
  }
  return K;
})();
const B_CENTER = bMatrix(0, 0, 0);

// ---- boundary conditions: faces to grid nodes ----

function nodesNear(triangles: Float32Array, grid: Grid, nodeIndex: Int32Array, radius: number): Set<number> {
  const [nx, ny, nz] = grid.dims;
  const NX = nx + 1, NY = ny + 1;
  const { pitch, origin } = grid;
  const found = new Set<number>();
  const visit = (x: number, y: number, z: number) => {
    const ci = (x - origin[0]) / pitch, cj = (y - origin[1]) / pitch, ck = (z - origin[2]) / pitch;
    const r = Math.ceil(radius / pitch);
    for (let k = Math.max(0, Math.floor(ck) - r); k <= Math.min(nz, Math.ceil(ck) + r); k++)
      for (let j = Math.max(0, Math.floor(cj) - r); j <= Math.min(ny, Math.ceil(cj) + r); j++)
        for (let i = Math.max(0, Math.floor(ci) - r); i <= Math.min(nx, Math.ceil(ci) + r); i++) {
          const u = nodeIndex[i + NX * (j + NY * k)];
          if (u < 0 || found.has(u)) continue;
          if (Math.hypot(i - ci, j - cj, k - ck) * pitch <= radius) found.add(u);
        }
  };
  const step = pitch / 2;
  for (let t = 0; t < triangles.length; t += 9) {
    const a = triangles.subarray(t, t + 3), b = triangles.subarray(t + 3, t + 6), c = triangles.subarray(t + 6, t + 9);
    const len = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
    const n = Math.max(1, Math.ceil(len / step));
    for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
      const s = u / n, r = v / n, q = 1 - s - r;
      visit(q * a[0] + s * b[0] + r * c[0], q * a[1] + s * b[1] + r * c[1], q * a[2] + s * b[2] + r * c[2]);
    }
  }
  return found;
}

// ---- the solve ----

export function solve(grid: Grid, problem: Problem, opts: { rtol?: number; maxIter?: number } = {}): Solution {
  const [nx, ny, nz] = grid.dims;
  const NX = nx + 1, NY = ny + 1, NZ = nz + 1;
  const { solid, pitch } = grid;

  // number the nodes that belong to a solid voxel
  const nodeIndex = new Int32Array(NX * NY * NZ).fill(-1);
  let nNodes = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid[i + nx * (j + ny * k)]) continue;
    for (const [di, dj, dk] of LOCAL) {
      const g = i + di + NX * (j + dj + NY * (k + dk));
      if (nodeIndex[g] < 0) nodeIndex[g] = nNodes++;
    }
  }
  const nodeIJK = new Int32Array(nNodes * 3);
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const u = nodeIndex[i + NX * (j + NY * k)];
    if (u >= 0) { nodeIJK[3 * u] = i; nodeIJK[3 * u + 1] = j; nodeIJK[3 * u + 2] = k; }
  }

  // 27 neighbor slots per node, each a 3x3 block
  const nbr = new Int32Array(nNodes * 27).fill(-1);
  for (let u = 0; u < nNodes; u++) {
    const i = nodeIJK[3 * u], j = nodeIJK[3 * u + 1], k = nodeIJK[3 * u + 2];
    for (let s = 0; s < 27; s++) {
      const ii = i + (s % 3) - 1, jj = j + (Math.floor(s / 3) % 3) - 1, kk = k + Math.floor(s / 9) - 1;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= NX || jj >= NY || kk >= NZ) continue;
      nbr[u * 27 + s] = nodeIndex[ii + NX * (jj + NY * kk)];
    }
  }
  const vals = new Float64Array(nNodes * 27 * 9);
  const scale = problem.material.E * pitch;
  const elNodes = new Int32Array(8);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid[i + nx * (j + ny * k)]) continue;
    LOCAL.forEach(([di, dj, dk], a) => { elNodes[a] = nodeIndex[i + di + NX * (j + dj + NY * (k + dk))]; });
    for (let a = 0; a < 8; a++) {
      const ua = elNodes[a];
      for (let b = 0; b < 8; b++) {
        const s = (LOCAL[b][0] - LOCAL[a][0] + 1) + 3 * (LOCAL[b][1] - LOCAL[a][1] + 1) + 9 * (LOCAL[b][2] - LOCAL[a][2] + 1);
        const base = (ua * 27 + s) * 9;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
          vals[base + r * 3 + c] += scale * KE1[(3 * a + r) * 24 + 3 * b + c];
      }
    }
  }

  // supports and load
  const n = nNodes * 3;
  const fixed = new Uint8Array(n);
  const holdNodes = new Set<number>();
  for (const h of problem.holds) for (const u of nodesNear(h, grid, nodeIndex, 0.87 * pitch)) holdNodes.add(u);
  for (const u of holdNodes) fixed[3 * u] = fixed[3 * u + 1] = fixed[3 * u + 2] = 1;
  const loadNodes = [...nodesNear(problem.load, grid, nodeIndex, 0.87 * pitch)].filter((u) => !holdNodes.has(u));
  const f = new Float64Array(n);
  for (const u of loadNodes) f[3 * u + 2] -= problem.forceN / loadNodes.length;

  const matvec = (x: Float64Array, y: Float64Array) => {
    for (let u = 0; u < nNodes; u++) {
      let y0 = 0, y1 = 0, y2 = 0;
      for (let s = 0; s < 27; s++) {
        const m = nbr[u * 27 + s];
        if (m < 0) continue;
        const x0 = x[3 * m], x1 = x[3 * m + 1], x2 = x[3 * m + 2];
        if (x0 === 0 && x1 === 0 && x2 === 0) continue;
        const b = (u * 27 + s) * 9;
        y0 += vals[b] * x0 + vals[b + 1] * x1 + vals[b + 2] * x2;
        y1 += vals[b + 3] * x0 + vals[b + 4] * x1 + vals[b + 5] * x2;
        y2 += vals[b + 6] * x0 + vals[b + 7] * x1 + vals[b + 8] * x2;
      }
      y[3 * u] = fixed[3 * u] ? 0 : y0;
      y[3 * u + 1] = fixed[3 * u + 1] ? 0 : y1;
      y[3 * u + 2] = fixed[3 * u + 2] ? 0 : y2;
    }
  };
  const diag = new Float64Array(n);
  for (let u = 0; u < nNodes; u++) for (let r = 0; r < 3; r++) diag[3 * u + r] = vals[(u * 27 + 13) * 9 + r * 4] || 1;

  // Jacobi-preconditioned conjugate gradients on the free degrees of freedom
  const x = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = fixed[i] ? 0 : f[i];
  const fNorm = Math.sqrt(r.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  const rtol = opts.rtol ?? 1e-6, maxIter = opts.maxIter ?? 20000;
  let iter = 0, converged = !loadNodes.length || !holdNodes.size;
  for (; iter < maxIter && !converged; iter++) {
    matvec(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break; // unrestrained: the holds don't stop the part moving
    const alpha = rz / pAp;
    let rr = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rr += r[i] * r[i]; }
    if (Math.sqrt(rr) / fNorm < rtol) { converged = true; break; }
    let rzNew = 0;
    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; rzNew += r[i] * z[i]; }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }

  // stresses at element centers
  const D = constitutive(problem.material.E, NU);
  const vonMises = new Float32Array(solid.length), principal = new Float32Array(solid.length);
  let peakVM = 0, peakT = 0, hotspot: [number, number, number] = [0, 0, 0];
  const ue = new Float64Array(24), eps = new Float64Array(6), sig = new Float64Array(6);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const e = i + nx * (j + ny * k);
    if (!solid[e]) continue;
    LOCAL.forEach(([di, dj, dk], a) => {
      const u = nodeIndex[i + di + NX * (j + dj + NY * (k + dk))];
      ue[3 * a] = x[3 * u]; ue[3 * a + 1] = x[3 * u + 1]; ue[3 * a + 2] = x[3 * u + 2];
    });
    for (let q = 0; q < 6; q++) { let s = 0; for (let c = 0; c < 24; c++) s += B_CENTER[q][c] * ue[c]; eps[q] = s / pitch; }
    for (let q = 0; q < 6; q++) { let s = 0; for (let c = 0; c < 6; c++) s += D[q][c] * eps[c]; sig[q] = s; }
    const [sx, sy, sz, txy, tyz, tzx] = sig;
    const vm = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy ** 2 + tyz ** 2 + tzx ** 2));
    const p1 = maxPrincipal(sx, sy, sz, txy, tyz, tzx);
    vonMises[e] = vm;
    principal[e] = p1;
    if (vm > peakVM) {
      peakVM = vm;
      hotspot = [grid.origin[0] + (i + 0.5) * pitch, grid.origin[1] + (j + 0.5) * pitch, grid.origin[2] + (k + 0.5) * pitch];
    }
    if (p1 > peakT) peakT = p1;
  }
  let sag = 0;
  for (let u = 0; u < nNodes; u++) sag = Math.max(sag, -x[3 * u + 2]);

  return {
    vonMises, principal, peakVonMises: peakVM, peakTension: peakT, hotspot, sagMm: sag,
    iterations: iter, converged, fixedNodes: holdNodes.size, loadNodes: loadNodes.length,
  };
}

/** Largest eigenvalue of a symmetric 3x3 stress tensor (trigonometric method). */
function maxPrincipal(sx: number, sy: number, sz: number, txy: number, tyz: number, tzx: number): number {
  const p1 = txy * txy + tyz * tyz + tzx * tzx;
  const q = (sx + sy + sz) / 3;
  if (p1 < 1e-18) return Math.max(sx, sy, sz);
  const p2 = (sx - q) ** 2 + (sy - q) ** 2 + (sz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b11 = (sx - q) / p, b22 = (sy - q) / p, b33 = (sz - q) / p, b12 = txy / p, b23 = tyz / p, b13 = tzx / p;
  const detB = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const r = Math.max(-1, Math.min(1, detB / 2));
  return q + 2 * p * Math.cos(Math.acos(r) / 3);
}
