/// <reference lib="webworker" />
// Runs the stress solve off the main thread and maps the result back onto the
// viewer's mesh vertices.
import { voxelize } from "./voxelize.ts";
import { MATERIALS, solve } from "./fem.ts";

export interface StressRequest {
  positions: Float32Array;
  holds: Float32Array[];
  load: Float32Array;
  kg: number;
  material: string;
}

export interface StressResult {
  vertexStress: Float32Array; // von Mises at each display vertex, MPa
  peakMPa: number;
  peakTensionMPa: number;
  hotspot: [number, number, number];
  sagMm: number;
  elements: number;
  pitch: number;
  converged: boolean;
  safety: number;           // the smaller of the two factors below
  failsBy: "plastic" | "layers";
  breakKg: number;
  ms: number;
}

self.onmessage = (e: MessageEvent<StressRequest>) => {
  try {
    const started = performance.now();
    const { positions, holds, load, kg, material } = e.data;
    const mat = MATERIALS.find((m) => m.name === material) ?? MATERIALS[0];
    const grid = voxelize(positions);
    const s = solve(grid, { material: mat, holds, load, forceN: kg * 9.81 });
    if (!s.converged || !s.fixedNodes || !s.loadNodes) {
      throw new Error(!s.fixedNodes || !s.loadNodes
        ? "Couldn't attach the load or the holds to the part. Pick faces again."
        : "The holds don't stop the part moving. Add another hold.");
    }

    // each display vertex takes the stress of the solid voxel it sits in (or the nearest one)
    const [nx, ny, nz] = grid.dims;
    const vertexStress = new Float32Array(positions.length / 3);
    for (let v = 0; v < vertexStress.length; v++) {
      const ci = (positions[3 * v] - grid.origin[0]) / grid.pitch;
      const cj = (positions[3 * v + 1] - grid.origin[1]) / grid.pitch;
      const ck = (positions[3 * v + 2] - grid.origin[2]) / grid.pitch;
      let best = -1, bestD = Infinity;
      for (let k = Math.floor(ck) - 1; k <= Math.floor(ck) + 1; k++) for (let j = Math.floor(cj) - 1; j <= Math.floor(cj) + 1; j++)
        for (let i = Math.floor(ci) - 1; i <= Math.floor(ci) + 1; i++) {
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
          const idx = i + nx * (j + ny * k);
          if (!grid.solid[idx]) continue;
          const d = (i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2 + (k + 0.5 - ck) ** 2;
          if (d < bestD) { bestD = d; best = idx; }
        }
      vertexStress[v] = best >= 0 ? s.vonMises[best] : 0;
    }

    const plastic = mat.yield / (s.peakVonMises || 1e-9);
    const layers = mat.layer / (s.peakTension || 1e-9);
    const safety = Math.min(plastic, layers);
    const result: StressResult = {
      vertexStress, peakMPa: s.peakVonMises, peakTensionMPa: s.peakTension, hotspot: s.hotspot, sagMm: s.sagMm,
      elements: grid.count, pitch: grid.pitch, converged: s.converged, safety,
      failsBy: layers < plastic ? "layers" : "plastic", breakKg: kg * safety, ms: performance.now() - started,
    };
    (self as unknown as Worker).postMessage({ ok: true, result }, [vertexStress.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message });
  }
};
