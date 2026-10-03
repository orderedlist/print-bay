// node --test app/web/src/stress/fem.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { voxelize } from "./voxelize.ts";
import { MATERIALS, solve } from "./fem.ts";

/** Triangles of an axis-aligned box, outward-facing. */
function box(x: number, y: number, z: number) {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const quads = { bottom: [0, 3, 2, 1], top: [4, 5, 6, 7], front: [0, 1, 5, 4], back: [2, 3, 7, 6], left: [0, 4, 7, 3], right: [1, 2, 6, 5] };
  const faces: Record<string, Float32Array> = {};
  for (const [name, [a, b, c, d]] of Object.entries(quads)) faces[name] = new Float32Array([...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]]);
  const all = new Float32Array(Object.values(faces).flatMap((f) => [...f]));
  return { all, faces };
}

test("cantilever deflection matches beam theory", () => {
  // 100 x 10 x 10 mm PLA beam, clamped at x = 0, 10 N down at the free end
  const { all, faces } = box(100, 10, 10);
  const grid = voxelize(all, 1);
  assert.equal(grid.count, 100 * 10 * 10);
  const pla = MATERIALS[0];
  const started = Date.now();
  const s = solve(grid, { material: pla, holds: [faces.left], load: faces.right, forceN: 10 });
  const I = (10 * 10 ** 3) / 12;
  const beam = (10 * 100 ** 3) / (3 * pla.E * I); // ~1.14 mm
  console.log(`sag ${s.sagMm.toFixed(3)} mm vs beam ${beam.toFixed(3)} mm, peak ${s.peakVonMises.toFixed(1)} MPa, ` +
    `${s.iterations} iterations, ${Date.now() - started} ms`);
  assert.ok(s.converged);
  assert.ok(Math.abs(s.sagMm - beam) / beam < 0.12, `sag ${s.sagMm} vs ${beam}`);
  // bending stress at the root: M c / I = 10*100*5/833 = 6 MPa (the clamp concentrates it)
  assert.ok(s.peakVonMises > 5 && s.peakVonMises < 20, `peak ${s.peakVonMises}`);
});

test("an unrestrained part doesn't pretend to converge", () => {
  const { all, faces } = box(20, 10, 10);
  const s = solve(voxelize(all, 1), { material: MATERIALS[0], holds: [], load: faces.top, forceN: 10 });
  assert.equal(s.fixedNodes, 0);
  assert.equal(s.sagMm, 0);
});
