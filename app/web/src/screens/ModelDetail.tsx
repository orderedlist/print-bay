import { useEffect, useState, type ReactNode } from "react";
import type * as THREE from "three";
import { api, inches, mm, money, title, useAgentSession, type Live } from "../api";
import { AgentPanel } from "../components/AgentPanel";
import type { AgentSession, CheckReport } from "../types";
import { SEVERITY_COLORS } from "../components/ModelViewer";
import { ModelViewer } from "../components/ModelViewer";
import type { Model, ScadParam } from "../types";

interface Props {
  model: Model;
  live: Live;
  back: () => void;
  print: (model: Model) => void;
  toast: (msg: string, error?: boolean) => void;
}

// Common revisions, offered as starting points in the Claude sidebar.
const EDIT_STARTERS = [
  "Make it stronger where it's weakest",
  "Add a 1 mm chamfer to the outside edges",
  "Make it print without supports",
  "Cut the print time without making it weaker",
  "It's too loose: tighten the fit by 0.2 mm",
];

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
  const [agentId, setAgentId] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "params" | "checks" | "claude">("details");
  const session = useAgentSession(agentId, live);
  const canEdit = model.kind === "scad";

  /** The model's Claude chat: the latest one, or a new one. */
  const openAgent = async (fresh = false): Promise<AgentSession | null> => {
    setTab("claude");
    try {
      const existing = fresh ? null : await api<AgentSession | null>(`/api/models/${model.id}/agent`);
      const s = existing ?? await api<AgentSession>("/api/agent", { method: "POST", json: { kind: "edit", modelId: model.id } });
      setAgentId(s.id);
      return s;
    } catch (e) { toast((e as Error).message, true); return null; }
  };

  // printability checks on the model as it will be sliced
  const [checks, setChecks] = useState<CheckReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [layoutSignal, setLayoutSignal] = useState(0);
  useEffect(() => {
    let alive = true;
    setChecking(true);
    api<CheckReport>(`/api/models/${model.id}/checks`)
      .then((r) => alive && setChecks(r))
      .catch(() => alive && setChecks(null))
      .finally(() => alive && setChecking(false));
    return () => { alive = false; };
  }, [model.id, model.meshKey, live.modelsVersion]);

  /** "Analyze and correct": a review pass by Claude using every rule it knows plus the checks. */
  const analyze = async () => {
    const s = await openAgent();
    if (!s) return;
    if (s.running) { toast("Claude is still working on the last message", true); return; }
    api(`/api/agent/${s.id}/review`, { method: "POST" }).catch((e) => toast(e.message, true));
  };
  const log = job ? live.slice[job.name] ?? [] : [];
  const slicing = job?.slicing || log.at(-1)?.state === "running";

  // resume the model's last chat, so a running edit or review shows up in the Claude tab
  useEffect(() => {
    api<AgentSession | null>(`/api/models/${model.id}/agent`).then((s) => s && setAgentId(s.id)).catch(() => {});
  }, [model.id]);

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

  const issues = checks ? checks.findings.filter((f) => f.severity !== "info").length : 0;
  const tabs = [
    { id: "details" as const, label: "Details" },
    ...(params.length ? [{ id: "params" as const, label: "Parameters" }] : []),
    { id: "checks" as const, label: "Checks", badge: issues || null },
    { id: "claude" as const, label: "Claude", busy: session?.running },
  ];

  return (
    <main className="page model-page">
      <div className="model-viewer">
        <button className="tab" onClick={back} style={{ alignSelf: "flex-start" }}>← Library</button>
        <ModelViewer model={model} onSize={setSize} checks={checks} showLayoutSignal={layoutSignal} />
      </div>

      <aside className="card model-sidebar" aria-label={title(model.id)}>
        <div className="sidebar-head">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 20 }}>{title(model.id)}</h1>
            {model.kind && <span className="badge">{model.kind}</span>}
            {job?.stale && job.stats && <span className="badge badge-warn">changed since slice</span>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm btn-primary" disabled={!job} onClick={() => print(model)}>Print…</button>
            {job && <button className="btn btn-sm" disabled={slicing} onClick={() =>
              api(`/api/jobs/${job.name}/slice`, { method: "POST" }).catch((e) => toast(e.message, true))}>
              {slicing ? "Slicing…" : job.stats ? "Re-slice" : "Slice"}
            </button>}
          </div>
          <nav className="sidebar-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className="sidebar-tab"
                onClick={() => (t.id === "claude" && !agentId ? openAgent() : setTab(t.id))}>
                {t.label}
                {"badge" in t && t.badge ? <span className="tab-badge">{t.badge}</span> : null}
                {"busy" in t && t.busy ? <span className="agent-spinner" aria-label="working" /> : null}
              </button>
            ))}
          </nav>
        </div>

        {tab === "details" && (
          <div className="sidebar-body">
            <dl className="specs">
              <dt>Size</dt>
              <dd>{size ? `${mm(size.x)} × ${mm(size.y)} × ${mm(size.z)}` : "…"}
                {size && <div className="faint" style={{ fontSize: 12 }}>{inches(size.x)} × {inches(size.y)} × {inches(size.z)}</div>}</dd>
              <dt>File</dt><dd className="mono" style={{ fontSize: 12 }}>{model.file ?? "—"}</dd>
              {job && <>
                <dt>Job</dt><dd className="mono" style={{ fontSize: 12 }}>{job.file}</dd>
                <dt>Last slice</dt><dd>{job.stats ? `${job.stats.time} · ${Math.round(job.stats.grams)} g` : "not sliced"}</dd>
                {job.stats && <><dt>Cost</dt><dd>{money(job.stats.cost.total)} <span className="muted">each</span></dd></>}
              </>}
            </dl>
            {log.length > 0 && <div className="log" aria-live="polite">{log.map((l) => l.line).join("\n")}</div>}
            {model.source && <div className="sidebar-section"><h2 className="label">Notes</h2><Source text={model.source} /></div>}
          </div>
        )}

        {tab === "params" && (
          <div className="sidebar-body">
            <div className="muted" style={{ fontSize: 12 }}>OpenSCAD values: numbers or <code>n * in</code>. Hover a field for its note.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {params.map((p) => (
                <label key={p.name} title={p.comment} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span className="muted mono">{p.name}{p.value !== p.default && !(p.name in edits) ? " •" : ""}</span>
                  <input className="field mono" value={value(p)} spellCheck={false}
                    onChange={(e) => setEdits({ ...edits, [p.name]: e.target.value })} />
                </label>
              ))}
            </div>
            <div className="faint" style={{ fontSize: 12 }}>• overridden in {job?.file}</div>
            <div className="sidebar-foot">
              <button className="btn btn-sm" disabled={(!dirty && params.every((p) => p.value === p.default)) || saving || slicing}
                onClick={() => setEdits(Object.fromEntries(params.map((p) => [p.name, p.default])))}>Reset to file</button>
              <button className="btn btn-sm btn-primary" disabled={!dirty || saving || slicing} onClick={saveAndSlice}>
                {saving ? "Saving…" : "Save & re-slice"}
              </button>
            </div>
          </div>
        )}

        {tab === "checks" && (
          <div className="sidebar-body">
            <div className="muted" style={{ fontSize: 13 }}>
              {checking ? "Checking the model as it will print…" : checks ? `${issues || "No"} issue${issues === 1 ? "" : "s"} as it will print${checks.supports ? " (supports on)" : ""}.` : "Checks unavailable."}
            </div>
            {checks && checks.findings.length === 0 && <div className="muted">No overhangs, thin walls, loose pieces or bed problems found.</div>}
            {checks?.findings.map((f, i) => (
              <button key={i} className="finding" onClick={() => setLayoutSignal((n) => n + 1)} title={`${f.rule}: ${f.detail}`}>
                <i className="dot" style={{ background: SEVERITY_COLORS[f.severity], marginTop: 6 }} />
                <span>{f.message}<span className="faint mono" style={{ display: "block", fontSize: 11 }}>{f.rule} · {f.detail}</span></span>
              </button>
            ))}
            {canEdit && (
              <div className="sidebar-foot" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <button className="btn" disabled={session?.running} onClick={analyze}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
                  Analyze and correct
                </button>
                <div className="faint" style={{ fontSize: 12 }}>Claude reviews the model against its design rules and these checks, then fixes what it can. Follow along and undo in the Claude tab.</div>
              </div>
            )}
          </div>
        )}

        {tab === "claude" && (
          <div className="sidebar-chat">
            {!canEdit ? (
              <div className="sidebar-body muted">Claude can only edit OpenSCAD models. This one is a downloaded {model.kind?.toUpperCase()} mesh,
                so its shape is fixed; start a <a href="#/new">new model</a> to have Claude design a version you can change.</div>
            ) : session ? (
              <>
                {session.transcript.length > 0 && !session.running && (
                  <div className="chat-tools"><button className="btn btn-sm" onClick={() => openAgent(true)}>New chat</button></div>
                )}
                <AgentPanel session={session} toast={toast} allowUploads starters={EDIT_STARTERS}
                  placeholder="Describe a change, e.g. “make the lip 8 mm tall” (⌘↩ to send)"
                  empty={<div className="muted" style={{ fontSize: 13 }}>
                    Claude edits <code>models/{model.id}/</code>{job ? <> and <code>{job.file}</code></> : null}, renders to check, and the
                    preview updates as it goes. Every change can be undone. Re-slice when you're happy.
                  </div>} />
              </>
            ) : <div className="sidebar-body muted">Starting…</div>}
          </div>
        )}
      </aside>
    </main>
  );
}
