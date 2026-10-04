import { useEffect, useState } from "react";
import { api, useAgentSession, type Live } from "../api";
import { AgentPanel } from "../components/AgentPanel";
import { ICONS } from "../components/Toolbar";
import type { AgentSession } from "../types";

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
  close: () => void;
  /** The first message named and created the model: open it, chat and all. */
  created: (modelId: string) => void;
  toast: (msg: string, error?: boolean) => void;
}

/**
 * "Create with Claude", in the inspector's place. The first message names the
 * model and creates it; from then on the chat lives in that model's Claude tab.
 */
export function CreatePanel({ live, close, created, toast }: Props) {
  const [id, setId] = useState<string | null>(null);
  const session = useAgentSession(id, live);

  useEffect(() => { // an unsent draft chat (photos added, say) is picked up again; otherwise a fresh one
    (async () => {
      try {
        const previous = stored();
        let s = previous ? await api<AgentSession>(`/api/agent/${previous}`).catch(() => null) : null;
        if (!s || s.modelId || s.turns) s = await api<AgentSession>("/api/agent", { method: "POST", json: { kind: "new" } });
        remember(s.id);
        setId(s.id);
      } catch (e) { toast((e as Error).message, true); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (session?.modelId) created(session.modelId); }, [session?.modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="panel side-panel inspector" aria-label="New model">
      <div className="panel-head drag" style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="ico" style={{ color: "var(--acc)" }}>{ICONS.spark}</span>
          <div style={{ flexGrow: 1 }}>
            <h1 style={{ fontSize: 15 }}>New model</h1>
            <div className="muted" style={{ fontSize: 12 }}>Designed with Claude</div>
          </div>
          <button className="ibtn" onClick={close} aria-label="Close" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column" }}>
        {session ? (
          <AgentPanel session={session} toast={toast} allowUploads starters={session.transcript.length ? undefined : STARTERS}
            placeholder="Describe what it's for and what it has to fit…"
            empty={<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ border: "1px dashed var(--line)", borderRadius: 12, padding: 18, textAlign: "center", background: "var(--panel2)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-8 8" /></svg>
                <div>Drop photos of the space or the part</div>
                <div className="faint" style={{ fontSize: 12 }}>or an SVG drawing to build from · paste works too</div>
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>Your first message names the model and adds it to the library. Claude asks
                a few questions, then designs a parametric OpenSCAD model sized for the K2, with a job file so it prints like everything else.</div>
            </div>} />
        ) : <div className="sec agent-note"><span className="spinner" /> Starting…</div>}
      </div>
    </aside>
  );
}
