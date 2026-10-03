import { useEffect, useMemo, useRef, useState } from "react";
import type { Stage } from "../stage";
import { MATERIALS } from "../stress/fem";
import { autoAim, growRegion, surface, trianglesOf, type Region } from "../stress/regions";
import type { StressRequest, StressResult } from "../stress/worker";

interface Props {
  stage: Stage;
  meshVersion: number; // bumps when the mesh is replaced: picks and results no longer apply
}

type Picking = "load" | "hold" | null;

function headline(r: StressResult, kg: number): { text: string; tone: string } {
  const k = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
  const lb = (n: number) => Math.round(n * 2.205);
  if (r.safety >= 100) return { text: "Barely feels this", tone: "var(--ok)" };
  if (r.safety < 1) return { text: `Would break: holds about ${k(r.breakKg)} kg, not ${k(kg)}`, tone: "var(--danger)" };
  if (r.safety < 2) return { text: `Cutting it close: breaks around ${k(r.breakKg)} kg (${lb(r.breakKg)} lb)`, tone: "var(--warn)" };
  return { text: `Holds up to about ${k(r.breakKg)} kg (${lb(r.breakKg)} lb)`, tone: "var(--ok)" };
}

export function StressPanel({ stage, meshVersion }: Props) {
  const [picking, setPicking] = useState<Picking>("load");
  const [load, setLoad] = useState<Region | null>(null);
  const [holds, setHolds] = useState<Region[]>([]);
  const [kg, setKg] = useState(5);
  const [material, setMaterial] = useState("PLA");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StressResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);

  const positions = stage.positions;
  const surf = useMemo(() => (positions ? surface(positions) : null), [positions, meshVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new mesh (edited model) invalidates everything
  useEffect(() => {
    setLoad(null); setHolds([]); setResult(null); setError(null); setPicking("load");
  }, [meshVersion]);

  // show picks until there's a result
  useEffect(() => {
    if (result) return;
    stage.showRegions(holds.map((h) => h.triangles), load?.triangles ?? null);
    stage.setMarkers([
      ...(load ? [{ at: load.centroid, color: "#ff8a3d", down: true }] : []),
      ...holds.map((h) => ({ at: h.centroid, color: "#3d8bfd" })),
    ]);
  }, [stage, load, holds, result]);

  // clicking the mesh picks faces
  useEffect(() => {
    stage.onPick = (tri) => {
      if (!surf || !picking) return;
      setResult(null);
      setError(null);
      if (picking === "load") {
        setLoad(growRegion(surf, tri));
        setPicking("hold");
      } else {
        setHolds((hs) => {
          const existing = hs.findIndex((h) => h.triangles.includes(tri));
          return existing >= 0 ? hs.filter((_, i) => i !== existing) : [...hs, growRegion(surf, tri)];
        });
      }
    };
    return () => { stage.onPick = null; };
  }, [stage, surf, picking]);

  useEffect(() => () => { worker.current?.terminate(); stage.plainColors(); stage.onPick = null; }, [stage]);

  const run = () => {
    if (!surf || !positions) return;
    let l = load, h = holds;
    if (!l || !h.length) {
      const aim = autoAim(surf);
      if (!aim) { setError("Couldn't guess where it's held. Pick the faces."); return; }
      l = l ?? aim.load;
      h = h.length ? h : [aim.hold];
      setLoad(l); setHolds(h);
    }
    worker.current?.terminate();
    const w = new Worker(new URL("../stress/worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setRunning(true); setError(null); setResult(null); setPicking(null);
    w.onmessage = (e: MessageEvent<{ ok: true; result: StressResult } | { ok: false; error: string }>) => {
      setRunning(false);
      w.terminate();
      if (!e.data.ok) { setError(e.data.error); return; }
      const r = e.data.result;
      setResult(r);
      stage.showStress(r.vertexStress, r.peakMPa);
      stage.setMarkers([
        { at: l!.centroid, color: "#ff8a3d", down: true },
        ...h.map((x) => ({ at: x.centroid, color: "#3d8bfd" })),
      ]);
    };
    const req: StressRequest = {
      positions: positions.slice(), kg, material,
      holds: h.map((x) => trianglesOf(surf, x)), load: trianglesOf(surf, l),
    };
    w.postMessage(req);
  };

  const reset = () => { setLoad(null); setHolds([]); setResult(null); setError(null); setPicking("load"); };
  const head = result ? headline(result, kg) : null;

  return (
    <div className="paths-ui stress-ui">
      {!result && (
        <div className="stress-steps">
          <button className="chip" aria-pressed={picking === "load"} onClick={() => setPicking("load")}>
            <i className="swatch" style={{ background: "#ff8a3d" }} />{load ? "Load picked" : "1. Click where the weight presses"}
          </button>
          <button className="chip" aria-pressed={picking === "hold"} onClick={() => setPicking("hold")}>
            <i className="swatch" style={{ background: "#3d8bfd" }} />{holds.length ? `${holds.length} hold${holds.length > 1 ? "s" : ""}` : "2. Click what holds it up"}
          </button>
        </div>
      )}
      {picking === "hold" && !result && <div className="faint">Click every face that holds it (each screw or hook). Click again to remove.</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>Load
          <input className="field mono" type="number" min={0.1} step={0.5} value={kg} style={{ width: 72, height: 36 }}
            onChange={(e) => { setKg(Math.max(0.1, Number(e.target.value) || 0.1)); setResult(null); }} /> kg
        </label>
        <select className="field" value={material} style={{ width: 90, height: 36 }} aria-label="Material"
          onChange={(e) => { setMaterial(e.target.value); setResult(null); }}>
          {MATERIALS.map((m) => <option key={m.name}>{m.name}</option>)}
        </select>
        <span className="spacer" />
        {(load || holds.length > 0 || result) && <button className="btn btn-sm" onClick={reset} disabled={running}>Reset</button>}
        <button className="btn btn-sm btn-primary" onClick={run} disabled={running}>
          {running ? "Solving…" : load && holds.length ? "Run" : "Run (auto-aim)"}
        </button>
      </div>
      {error && <div style={{ color: "#ffb3b3" }}>{error}</div>}
      {result && head && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 600, color: head.tone, fontSize: 15 }}>{head.text}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="stress-scale" aria-hidden="true" />
            <span className="mono muted">0 – {result.peakMPa.toFixed(1)} MPa</span>
          </div>
          <div className="faint mono" style={{ fontSize: 11 }}>
            sags {result.sagMm < 0.01 ? "<0.01" : result.sagMm.toFixed(2)} mm · fails first in the {result.failsBy === "layers" ? "layer seams" : "plastic"} ·
            {" "}{result.elements.toLocaleString()} voxels at {result.pitch.toFixed(1)} mm · {(result.ms / 1000).toFixed(1)} s · ±30%
          </div>
          {result.failsBy === "layers" && <div className="faint" style={{ fontSize: 12 }}>
            Layer strength assumes the worst orientation, so the real part may be stronger if layers run along the load.</div>}
        </div>
      )}
    </div>
  );
}
