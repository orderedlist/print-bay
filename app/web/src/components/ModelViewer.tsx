import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { api } from "../api";
import { FEATURE_COLORS, Stage, parseMesh, type Toolpaths } from "../stage";
import type { Theme } from "../theme";
import { StressPanel } from "./StressPanel";
import type { CheckReport, Model } from "../types";

export const SEVERITY_COLORS = { fail: "#e5484d", warn: "#f2a33a", info: "#3d8bfd" } as const;

export type ViewMode = "model" | "paths" | "stress" | "layout";
export interface ViewAvailability { model: boolean; paths: boolean; stress: boolean; layout: boolean }

interface Props {
  model: Model;
  mode: ViewMode;
  /** Falls back to the model view when the current one goes away (e.g. no toolpaths). */
  setMode: (mode: ViewMode) => void;
  theme: Theme;
  /** px to move the view's center right, so the part sits between the floating panels */
  shift: number;
  onSize?: (size: THREE.Vector3 | null) => void;
  onAvailable?: (views: ViewAvailability) => void;
  onStatus?: (msg: string | null) => void;
  checks?: CheckReport | null;
  /** The filament colours picked for printing (one per part), to show the part in. */
  colors?: string[];
}

/** The model on the full-window stage, plus the floating controls for the current view. */
export function ModelViewer({ model, mode, setMode, theme, shift, onSize, onAvailable, onStatus, checks, colors }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const modeRef = useRef(mode); // current mode for async loads (state in their closures is stale)
  modeRef.current = mode;
  const [meshVersion, setMeshVersion] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const colorKey = (colors ?? []).join(",");
  const [loading, setLoading] = useState<string | null>("Loading…");
  const [paths, setPaths] = useState<Toolpaths | null>(null);
  const [, redraw] = useState(0);
  const job = model.jobs.find((j) => j.stats);
  const pathsKey = job ? `${job.name}:${job.stats!.slicedAt}` : null;

  useEffect(() => {
    const s = new Stage(host.current!);
    setStage(s);
    return () => s.dispose();
  }, []);
  useEffect(() => { stage?.setTheme(theme); }, [stage, theme]);
  useEffect(() => { stage?.setShift(shift); }, [stage, shift]);
  useEffect(() => { onStatus?.(loading); }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // mesh
  useEffect(() => {
    if (!stage) return;
    let alive = true;
    setLoading(model.kind === "scad" ? "Rendering with OpenSCAD…" : model.kind === "py" ? "Building with nurb…" : "Loading…");
    api<ArrayBuffer>(`/api/models/${model.id}/mesh`)
      .then((buf) => {
        if (!alive) return;
        const { geometry, size } = parseMesh(buf, model.jobs[0]?.parts.map((p) => p.hex));
        stage.setMesh(geometry, model.jobs[0]?.hex ?? null);
        setMeshVersion((v) => v + 1);
        if (modeRef.current === "model" || modeRef.current === "stress") stage.showMesh();
        onSize?.(size);
        setLoading(null);
      })
      .catch((e) => alive && setLoading(`Couldn't load the model: ${e.message}`));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, model.meshKey]);

  // toolpaths
  useEffect(() => {
    if (!stage) return;
    let alive = true;
    if (!job) { stage.setToolpaths(null); setPaths(null); return; }
    api<ArrayBuffer>(`/api/jobs/${job.name}/toolpaths`)
      .then((buf) => alive && setPaths(stage.setToolpaths(buf)))
      .catch(() => alive && setPaths(null));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, pathsKey]);

  // the part as it will print, for the checks
  useEffect(() => {
    if (!stage) return;
    let alive = true;
    setLayoutReady(false);
    api<ArrayBuffer>(`/api/models/${model.id}/print-mesh`)
      .then((buf) => {
        if (!alive) return;
        stage.setLayoutMesh(parseMesh(buf, model.jobs[0]?.parts.map((p) => p.hex)).geometry, model.jobs[0]?.hex ?? null);
        setLayoutReady(true);
        setLayoutVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, model.meshKey]);

  // paint the picked filament colours, and again whenever a new mesh arrives
  useEffect(() => { if (stage && colors?.length) stage.recolor(colors); }, [stage, colorKey, meshVersion, layoutVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const available: ViewAvailability = { model: true, paths: !!paths, stress: !loading, layout: layoutReady };
  useEffect(() => { onAvailable?.(available); }, [available.paths, available.stress, available.layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!available[mode] && mode !== "stress") setMode("model"); }, [mode, available.paths, available.layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // show the current view
  const pins = () => (checks?.findings ?? []).map((f) => ({ at: f.at, color: SEVERITY_COLORS[f.severity] }));
  useEffect(() => {
    if (!stage) return;
    if (mode === "paths" && paths) stage.showPaths();
    else if (mode === "layout" && layoutReady) { stage.plainColors(); stage.showLayout(pins()); }
    else { stage.plainColors(); stage.showMesh(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, mode, paths, layoutReady, checks]);

  const update = (fn: (s: Stage) => void, reframe = false) => {
    if (!stage) return;
    fn(stage);
    stage.updatePaths();
    if (reframe) stage.framePaths();
    redraw((n) => n + 1);
  };

  return (
    <>
      <div className="viewer" ref={host} />
      {loading && <div className="stage-hint">{loading}</div>}
      {mode === "stress" && stage && !loading && <StressPanel key={model.id} stage={stage} meshVersion={meshVersion} />}
      {mode === "paths" && paths && stage && (
        <div className="panel float centered">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span className="mono muted">Layer {stage.layer + 1} / {paths.layers.length} · Z {paths.layers[stage.layer].toFixed(2)} mm</span>
            <span className="toggles">
              <label><input type="checkbox" checked={stage.xray} onChange={(e) => update((st) => { st.xray = e.target.checked; })} /> X-ray</label>
              <label><input type="checkbox" checked={stage.single} onChange={(e) => update((st) => { st.single = e.target.checked; }, true)} /> This layer only</label>
            </span>
          </div>
          <input className="rng" type="range" min={0} max={paths.layers.length - 1} value={stage.layer} aria-label="Layer"
            style={{ ["--f" as string]: `${(stage.layer / Math.max(1, paths.layers.length - 1)) * 100}%` }}
            onChange={(e) => update((st) => { st.layer = Number(e.target.value); }, stage.single)} />
          <div className="legend">
            {paths.types.map((t) => (
              <label key={t.name}>
                <input type="checkbox" checked={!stage.hidden.has(t.name)}
                  onChange={(e) => update((st) => { if (e.target.checked) st.hidden.delete(t.name); else st.hidden.add(t.name); })} />
                <i style={{ background: FEATURE_COLORS[t.name] ?? "#999" }} />{t.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
