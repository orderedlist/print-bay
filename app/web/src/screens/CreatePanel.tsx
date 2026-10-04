import { useEffect, useState } from "react";
import { api, title, useAgentSession, type Live } from "../api";
import { AgentPanel } from "../components/AgentPanel";
import { Thumb } from "../components/Thumb";
import type { AgentSession, Model } from "../types";

const KEY = "printbay.newModelSession";

// Starting points for a first request: each states what it's for and what it must fit.
const STARTERS = [
  "A wall hook for a 20 mm dowel, mounted with two screws",
  "A clip that holds a bundle of cables on the wall with one screw",
  "A knob for a 6 mm D-shaft",
  "A bin for small parts that fits a drawer (I'll measure it)",
  "A holder for my calipers that mounts under a shelf",
  "An adapter between two hoses (I'll give both diameters)",
];

function stored(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function remember(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode: fine */ }
}

interface Props {
  live: Live;
  models: Model[];
  back: () => void;
  openModel: (id: string) => void;
  /** The model Claude made, to show on the stage while the chat goes on. */
  onModel: (id: string | null) => void;
  toast: (msg: string, error?: boolean) => void;
}

/** "Create with Claude": a chat that designs a new OpenSCAD model. */
export function CreatePanel({ live, models, back, openModel, onModel, toast }: Props) {
  const [id, setId] = useState<string | null>(null);
  const session = useAgentSession(id, live);
  const model = session?.modelId ? models.find((m) => m.id === session.modelId) : undefined;
  useEffect(() => { onModel(model?.id ?? null); }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (fresh: boolean) => {
    try {
      let s: AgentSession | null = null;
      const previous = fresh ? null : stored();
      if (previous) s = await api<AgentSession>(`/api/agent/${previous}`).catch(() => null);
      s ??= await api<AgentSession>("/api/agent", { method: "POST", json: { kind: "new" } });
      remember(s.id);
      setId(s.id);
    } catch (e) { toast((e as Error).message, true); }
  };
  useEffect(() => { start(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="sec">
        <button className="sech" onClick={back} aria-label="Back to models">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          Create with Claude
        </button>
        {model && (
          <button className="row" style={{ marginTop: 10, background: "var(--panel2)" }} onClick={() => openModel(model.id)}>
            <span className="thumb"><Thumb model={model} /></span>
            <span className="row-text">
              <span className="row-title">{title(model.id)}</span>
              <span className="row-sub">Open to tweak, slice and print</span>
            </span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        )}
      </div>
      {session ? (
        <AgentPanel session={session} toast={toast} allowUploads starters={session.transcript.length ? undefined : STARTERS}
          onNewChat={() => { onModel(null); start(true); }}
          placeholder="Describe what it's for and what it has to fit…"
          empty={<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ border: "1px dashed var(--line)", borderRadius: 12, padding: 18, textAlign: "center", background: "var(--panel2)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-8 8" /></svg>
              <div>Drop photos of the space or the part</div>
              <div className="faint" style={{ fontSize: 12 }}>or paste them into the message</div>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>Claude asks a few questions first, then designs a parametric OpenSCAD model sized for the K2,
              with a job file so it prints like everything else. It shows up on the stage as it goes.</div>
          </div>} />
      ) : <div className="sec agent-note"><span className="spinner" /> Starting…</div>}
    </div>
  );
}
