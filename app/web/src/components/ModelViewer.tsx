import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { api } from "../api";
import { FEATURE_COLORS, Stage, parseMesh, type Toolpaths } from "../stage";
import { StressPanel } from "./StressPanel";
import type { CheckReport, Model } from "../types";

export const SEVERITY_COLORS = { fail: "#e5484d", warn: "#f2a33a", info: "#3d8bfd" } as const;

interface Props {
  model: Model;
  onSize: (size: THREE.Vector3 | null) => void;
  checks?: CheckReport | null;
  /** Bump to switch to the print layout view (e.g. from the checks list). */
  showLayoutSignal?: number;
}

export function ModelViewer({ model, onSize, checks, showLayoutSignal }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [mode, setMode] = useState<"model" | "paths" | "stress" | "layout">("model");
  const [layoutReady, setLayoutReady] = useState(false);
  const modeRef = useRef(mode); // current mode for async loads (state in their closures is stale)
  modeRef.current = mode;
  const [meshVersion, setMeshVersion] = useState(0);
  const [loading, setLoading] = useState<string | null>("Loading…");
  const [paths, setPaths] = useState<Toolpaths | null>(null);
  const [, redraw] = useState(0);
  const job = model.jobs.find((j) => j.stats);
  const pathsKey = job ? `${job.name}:${job.stats!.slicedAt}` : null;

  useEffect(() => {
    stage.current = new Stage(host.current!);
    return () => { stage.current?.dispose(); stage.current = null; };
  }, []);

  // mesh
  useEffect(() => {
    let alive = true;
    setLoading(model.kind === "scad" ? "Rendering with OpenSCAD…" : "Loading…");
    api<ArrayBuffer>(`/api/models/${model.id}/mesh`)
      .then((buf) => {
        if (!alive || !stage.current) return;
        const { geometry, size } = parseMesh(buf);
        stage.current.setMesh(geometry, model.jobs[0]?.hex ?? null);
        setMeshVersion((v) => v + 1);
        if (modeRef.current === "model" || modeRef.current === "stress") stage.current.showMesh();
        onSize(size);
        setLoading(null);
      })
      .catch((e) => alive && setLoading(`Couldn't load the model: ${e.message}`));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.meshKey]);

  // toolpaths
  useEffect(() => {
    let alive = true;
    if (!job) { stage.current?.setToolpaths(null); setPaths(null); setMode("model"); return; }
    api<ArrayBuffer>(`/api/jobs/${job.name}/toolpaths`)
      .then((buf) => alive && stage.current && setPaths(stage.current.setToolpaths(buf)))
      .catch(() => alive && setPaths(null));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  // the part as it will print, for the checks
  useEffect(() => {
    let alive = true;
    setLayoutReady(false);
    api<ArrayBuffer>(`/api/models/${model.id}/print-mesh`)
      .then((buf) => {
        if (!alive || !stage.current) return;
        stage.current.setLayoutMesh(parseMesh(buf).geometry, model.jobs[0]?.hex ?? null);
        setLayoutReady(true);
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.meshKey]);

  const pins = () => (checks?.findings ?? []).map((f) => ({ at: f.at, color: SEVERITY_COLORS[f.severity] }));
  useEffect(() => { // refresh pins when the checks change
    if (mode === "layout" && layoutReady) stage.current?.showLayout(pins());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, layoutReady]);
  useEffect(() => { if (showLayoutSignal) pick("layout"); }, [showLayoutSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = stage.current;
  const pick = (m: "model" | "paths" | "stress" | "layout") => {
    setMode(m);
    if (m === "paths") s?.showPaths();
    else if (m === "layout") { s?.plainColors(); s?.showLayout(pins()); }
    else { s?.plainColors(); s?.showMesh(); }
  };
  const update = (fn: (s: Stage) => void, reframe = false) => {
    if (!s) return;
    fn(s);
    s.updatePaths();
    if (reframe) s.framePaths();
    redraw((n) => n + 1);
  };

  return (
    <div className="stage" ref={host}>
      {loading && <div className="center">{loading}</div>}
      <div className="modes">
        <button className="chip" aria-pressed={mode === "model"} onClick={() => pick("model")}>Model</button>
        <button className="chip" aria-pressed={mode === "paths"} disabled={!paths}
          title={paths ? "" : "Slice the job to see its toolpaths"} onClick={() => pick("paths")}>Toolpaths</button>
        <button className="chip" aria-pressed={mode === "stress"} disabled={!!loading} onClick={() => pick("stress")}>Stress</button>
        <button className="chip" aria-pressed={mode === "layout"} disabled={!layoutReady} title="As it will print, with check findings"
          onClick={() => pick("layout")}>Layout</button>
      </div>
      {mode === "stress" && s && !loading && <StressPanel key={model.id} stage={s} meshVersion={meshVersion} />}
      {mode === "paths" && paths && s && (
        <div className="paths-ui">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span className="mono muted">Layer {s.layer + 1} / {paths.layers.length} · Z {paths.layers[s.layer].toFixed(2)} mm</span>
            <span className="toggles">
              <label><input type="checkbox" checked={s.xray} onChange={(e) => update((st) => { st.xray = e.target.checked; })} /> X-ray</label>
              <label><input type="checkbox" checked={s.single} onChange={(e) => update((st) => { st.single = e.target.checked; }, true)} /> This layer only</label>
            </span>
          </div>
          <input type="range" min={0} max={paths.layers.length - 1} value={s.layer} aria-label="Layer"
            onChange={(e) => update((st) => { st.layer = Number(e.target.value); }, s.single)} />
          <div className="legend">
            {paths.types.map((t) => (
              <label key={t.name}>
                <input type="checkbox" checked={!s.hidden.has(t.name)}
                  onChange={(e) => update((st) => { if (e.target.checked) st.hidden.delete(t.name); else st.hidden.add(t.name); })} />
                <i style={{ background: FEATURE_COLORS[t.name] ?? "#999" }} />{t.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
