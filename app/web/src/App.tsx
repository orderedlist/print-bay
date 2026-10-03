import { useCallback, useEffect, useState } from "react";
import { useLive, useModels } from "./api";
import { Library } from "./screens/Library";
import { ModelDetail } from "./screens/ModelDetail";
import { Printer, stateLabel } from "./screens/Printer";
import { PrintSheet } from "./screens/PrintSheet";
import type { Model } from "./types";

type Route = { screen: "printer" } | { screen: "library" } | { screen: "model"; id: string };

function parseRoute(hash: string): Route {
  const [, screen, id] = hash.split("/");
  if (screen === "library") return { screen: "library" };
  if (screen === "model" && id) return { screen: "model", id: decodeURIComponent(id) };
  return { screen: "printer" };
}

interface Toast { id: number; msg: string; error: boolean }

export function App() {
  const live = useLive();
  const models = useModels(live.modelsVersion);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [printing, setPrinting] = useState<Model | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = (hash: string) => { location.hash = hash; };

  const toast = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 5000);
  }, []);

  const status = live.status;
  const [label, color] = stateLabel(status?.state ?? "offline");
  const pct = Math.round((status?.progress ?? 0) * 100);
  const model = route.screen === "model" ? models?.find((m) => m.id === route.id) : undefined;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 9 14 4l9 5v10l-9 5-9-5z" /><path d="M5 9l9 5 9-5M14 14v10" />
          </svg>
          Print Bay
        </div>
        <nav className="tabs" aria-label="Sections">
          <button className="tab" aria-current={route.screen === "printer" ? "page" : undefined} onClick={() => go("/printer")}>Printer</button>
          <button className="tab" aria-current={route.screen !== "printer" ? "page" : undefined} onClick={() => go("/library")}>Library</button>
        </nav>
        <span className="spacer" />
        <span className="pill">
          <span className="dot" style={{ background: color }} />
          K2 · {label}{status?.state === "printing" || status?.state === "paused" ? ` · ${pct}%` : ""}
          {live.queue.entries.length > 0 && ` · ${live.queue.entries.length} queued`}
        </span>
      </header>

      {!models ? (
        <main className="page muted">Loading…</main>
      ) : route.screen === "printer" ? (
        <Printer live={live} models={models} toast={toast} openModel={(id) => go(`/model/${id}`)} />
      ) : route.screen === "library" ? (
        <Library models={models} openModel={(id) => go(`/model/${id}`)} print={setPrinting} />
      ) : model ? (
        <ModelDetail key={model.id} model={model} live={live} back={() => go("/library")} print={setPrinting} toast={toast} />
      ) : (
        <main className="page muted">No model named {route.id}.</main>
      )}

      {printing && <PrintSheet model={printing} status={status} close={() => setPrinting(null)} toast={toast} />}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={t.error ? "toast toast-error" : "toast"}>{t.msg}</div>)}
      </div>
    </>
  );
}
