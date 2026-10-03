import { useEffect, useState, type ReactNode } from "react";
import type * as THREE from "three";
import { api, inches, mm, money, title, type Live } from "../api";
import { ModelViewer } from "../components/ModelViewer";
import type { Model, ScadParam } from "../types";

interface Props {
  model: Model;
  live: Live;
  back: () => void;
  print: (model: Model) => void;
  toast: (msg: string, error?: boolean) => void;
}

/** Just enough Markdown for SOURCE.md: bullets, `code` and bare links. */
function Source({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(`[^`]+`|https?:\/\/\S+)/g).map((part, i) =>
      part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code>
        : /^https?:/.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>
          : part);
  const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("# "));
  const bullets = lines.filter((l) => l.startsWith("- "));
  const prose = lines.filter((l) => !l.startsWith("- ") && !l.startsWith("  "));
  return (
    <div className="muted" style={{ fontSize: 13 }}>
      {bullets.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{bullets.map((b, i) => <li key={i}>{inline(b.slice(2))}</li>)}</ul>}
      {prose.map((p, i) => <p key={i} style={{ margin: "8px 0 0" }}>{inline(p)}</p>)}
    </div>
  );
}

export function ModelDetail({ model, live, back, print, toast }: Props) {
  const job = model.jobs[0];
  const [size, setSize] = useState<THREE.Vector3 | null>(null);
  const [params, setParams] = useState<ScadParam[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const log = job ? live.slice[job.name] ?? [] : [];
  const slicing = job?.slicing || log.at(-1)?.state === "running";

  useEffect(() => {
    if (!job || model.kind !== "scad") { setParams([]); return; }
    api<ScadParam[]>(`/api/jobs/${job.name}/params`).then((p) => { setParams(p); setEdits({}); }).catch(() => setParams([]));
  }, [job?.name, model.kind, live.modelsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Object.keys(edits).length > 0;
  const value = (p: ScadParam) => edits[p.name] ?? p.value;

  const saveAndSlice = async () => {
    if (!job) return;
    setSaving(true);
    try {
      const values = Object.fromEntries(params.map((p) => [p.name, value(p)]));
      await api(`/api/jobs/${job.name}/params`, { method: "PUT", json: { values } });
      await api(`/api/jobs/${job.name}/slice`, { method: "POST" });
    } catch (e) {
      toast((e as Error).message, true);
    }
    setSaving(false);
  };

  return (
    <main className="page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div><button className="tab" onClick={back}>← Library</button></div>
      <div className="split">
        <section className="wide"><ModelViewer model={model} onSize={setSize} /></section>
        <aside className="side">
          <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h1 style={{ fontSize: 22 }}>{title(model.id)}</h1>
                {model.kind && <span className="badge">{model.kind}</span>}
              </div>
            </div>
            <dl className="specs">
              <dt>Size</dt>
              <dd>{size ? `${mm(size.x)} × ${mm(size.y)} × ${mm(size.z)}` : "…"}
                {size && <div className="faint" style={{ fontSize: 12 }}>{inches(size.x)} × {inches(size.y)} × {inches(size.z)}</div>}</dd>
              <dt>File</dt><dd className="mono" style={{ fontSize: 12 }}>{model.file ?? "—"}</dd>
              {job && <>
                <dt>Job</dt><dd className="mono" style={{ fontSize: 12 }}>{job.file}</dd>
                <dt>Last slice</dt>
                <dd>{job.stats ? `${job.stats.time} · ${Math.round(job.stats.grams)} g` : "not sliced"}
                  {job.stale && job.stats && <div className="badge badge-warn" style={{ display: "inline-block", marginLeft: 8 }}>changed since</div>}</dd>
                {job.stats && <><dt>Cost</dt><dd>{money(job.stats.cost.total)} <span className="muted">each</span></dd></>}
              </>}
            </dl>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn btn-primary" disabled={!job} onClick={() => print(model)}>Print…</button>
              {job && <button className="btn" disabled={slicing} onClick={() =>
                api(`/api/jobs/${job.name}/slice`, { method: "POST" }).catch((e) => toast(e.message, true))}>
                {slicing ? "Slicing…" : job.stats ? "Re-slice" : "Slice"}
              </button>}
            </div>
            {log.length > 0 && <div className="log" aria-live="polite">{log.map((l) => l.line).join("\n")}</div>}
          </div>

          {params.length > 0 && (
            <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="card-head" style={{ marginBottom: 0 }}>
                <h2 style={{ fontSize: 15 }}>Parameters</h2>
                <span className="muted" style={{ fontSize: 12 }}>OpenSCAD · numbers or <code>n * in</code></span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                {params.map((p) => (
                  <label key={p.name} title={p.comment} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span className="muted mono">{p.name}{p.value !== p.default && !(p.name in edits) ? " •" : ""}</span>
                    <input className="field mono" value={value(p)} spellCheck={false}
                      onChange={(e) => setEdits({ ...edits, [p.name]: e.target.value })} />
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" disabled={(!dirty && params.every((p) => p.value === p.default)) || saving || slicing}
                  onClick={() => setEdits(Object.fromEntries(params.map((p) => [p.name, p.default])))}>Reset to file</button>
                <button className="btn btn-primary" disabled={!dirty || saving || slicing} onClick={saveAndSlice}>
                  {saving ? "Saving…" : "Save & re-slice"}
                </button>
              </div>
              <div className="faint" style={{ fontSize: 12 }}>• overridden in {job?.file}. Hover a field for its note.</div>
            </div>
          )}

          {model.source && <div className="card card-pad"><Source text={model.source} /></div>}
        </aside>
      </div>
    </main>
  );
}
