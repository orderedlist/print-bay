import { useEffect, useState } from "react";
import type * as THREE from "three";
import { api, mm, title, useAgentSession, type Live } from "../api";
import { AgentPanel } from "../components/AgentPanel";
import { ModelViewer } from "../components/ModelViewer";
import type { AgentSession, Model } from "../types";

const KEY = "printbay.newModelSession";

function stored(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function remember(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode: fine */ }
}

interface Props {
  live: Live;
  models: Model[];
  openModel: (id: string) => void;
  toast: (msg: string, error?: boolean) => void;
}

export function NewModel({ live, models, openModel, toast }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [size, setSize] = useState<THREE.Vector3 | null>(null);
  const session = useAgentSession(id, live);
  const model = session?.modelId ? models.find((m) => m.id === session.modelId) : undefined;

  const start = async (fresh: boolean) => {
    try {
      let s: AgentSession | null = null;
      const previous = fresh ? null : stored();
      if (previous) s = await api<AgentSession>(`/api/agent/${previous}`).catch(() => null);
      s ??= await api<AgentSession>("/api/agent", { method: "POST", json: { kind: "new" } });
      remember(s.id);
      setId(s.id);
      setSize(null);
    } catch (e) { toast((e as Error).message, true); }
  };
  useEffect(() => { start(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <a className="tab" href="#/library" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>← Library</a>
        <h1 style={{ fontSize: 22 }}>New model</h1>
        <span className="spacer" />
        {session && session.transcript.length > 0 && !session.running &&
          <button className="btn btn-sm" onClick={() => start(true)}>Start over</button>}
      </div>
      <div className="split">
        <section className="wide">
          <div className="card new-chat">
            {session ? (
              <AgentPanel session={session} toast={toast} allowUploads
                placeholder="What should we make? Add photos of the space or the thing it holds. (⌘↩ to send)"
                empty={<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>Describe what you need</div>
                  <div className="muted">Claude asks a few questions, then designs a parametric OpenSCAD model sized for the K2,
                    with a job file so it prints like everything else in the library. Photos help: drop them here or paste.</div>
                  <div className="faint" style={{ fontSize: 13 }}>e.g. “a wall hook for a 20 mm dowel”, “a tray that fits this drawer” + a photo</div>
                </div>} />
            ) : <div className="card-pad muted">Starting…</div>}
          </div>
        </section>
        <aside className="side">
          {model ? (
            <>
              <ModelViewer model={model} onSize={setSize} />
              <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 style={{ fontSize: 18 }}>{title(model.id)}</h2>
                  <span className="badge">{model.kind}</span>
                </div>
                {size && <div className="muted">{mm(size.x)} × {mm(size.y)} × {mm(size.z)}</div>}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn btn-primary" onClick={() => openModel(model.id)}>Open in library</button>
                </div>
                <div className="faint" style={{ fontSize: 13 }}>Keep chatting to change it, or open it to tweak parameters, slice and print.</div>
              </div>
            </>
          ) : (
            <div className="card card-pad muted" style={{ minHeight: 240, display: "grid", placeItems: "center", textAlign: "center" }}>
              {session?.running ? "Claude is working on it…" : "The preview appears here once Claude creates the model."}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
