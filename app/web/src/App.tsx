import { useCallback, useEffect, useRef, useState } from "react";
import { useLive, useModels } from "./api";
import { Camera } from "./components/Camera";
import { ModelViewer } from "./components/ModelViewer";
import { ICONS, Toolbar } from "./components/Toolbar";
import { CreatePanel } from "./screens/CreatePanel";
import { ModelsPanel } from "./screens/ModelsPanel";
import { ModelWorkspace, type InspectorTab } from "./screens/ModelWorkspace";
import { PrinterPanel, printerCaption, stateLabel } from "./screens/PrinterPanel";
import { useTheme } from "./theme";

// #/printer (the default), #/models, #/models/<id>, #/create. Older links still work.
type Route = { left: "printer" } | { left: "models"; id: string | null } | { left: "create" };

function parseRoute(hash: string): Route {
  const [, screen, id] = hash.split("/");
  if (screen === "models" || screen === "model") return { left: "models", id: id ? decodeURIComponent(id) : null };
  if (screen === "library") return { left: "models", id: null };
  if (screen === "create" || screen === "new") return { left: "create" };
  return { left: "printer" };
}

interface Toast { id: number; msg: string; error: boolean }

const LEFT_W = 300, CREATE_W = 360, RIGHT_W = 320, GAP = 14;

function useNarrow() {
  const query = "(max-width: 820px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function App() {
  const live = useLive();
  const models = useModels(live.modelsVersion);
  const [theme, toggleTheme] = useTheme();
  const narrow = useNarrow();
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [tab, setTab] = useState<InspectorTab>("print");
  const [created, setCreated] = useState<string | null>(null); // the model a Create chat made
  const [toasts, setToasts] = useState<Toast[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = (hash: string) => { location.hash = hash; };
  const openModel = (id: string) => go(`/models/${encodeURIComponent(id)}`);

  // ⌘F: search the library
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        if (route.left !== "models") go("/models");
        setTimeout(() => search.current?.focus(), 0);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [route.left]);

  const toast = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 5000);
  }, []);

  const selectedId = route.left === "models" ? route.id : null;
  const selected = selectedId ? models?.find((m) => m.id === selectedId) : undefined;
  const preview = route.left === "create" && created ? models?.find((m) => m.id === created) : undefined;
  const leftW = route.left === "create" ? CREATE_W : LEFT_W;
  const rightW = selected ? RIGHT_W : 0;
  const shift = narrow ? 0 : ((leftW + GAP) - (rightW ? rightW + GAP : 0)) / 2;
  const [, stateColor] = stateLabel(live.status?.state ?? "offline");
  const newModelActions = [{ label: "New model with Claude", icon: ICONS.plus, run: () => go("/create") }];
  const n = models?.length ?? 0;

  return (
    <div className={`ws${selected ? " with-inspector" : ""}${route.left === "create" ? " creating" : ""}`}>
      <main className="stage-area" aria-label="Stage">
        {route.left === "printer" ? (
          <Camera />
        ) : selected ? (
          <ModelWorkspace key={selected.id} model={selected} live={live} tab={tab} setTab={setTab} theme={theme} toggleTheme={toggleTheme}
            shift={shift} inspectorSlot={inspectorSlot} close={() => go("/models")} goPrinter={() => go("/printer")} newModel={() => go("/create")} toast={toast} />
        ) : preview ? (
          <>
            <ModelViewer key={preview.id} model={preview} mode="model" setMode={() => {}} theme={theme} shift={shift} />
            <Toolbar actions={newModelActions} mode={null} theme={theme} toggleTheme={toggleTheme} />
          </>
        ) : (
          <>
            <div className="stage-hint">
              {route.left === "create" ? (
                <><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
                  <b>The new model appears here</b><span style={{ fontSize: 12 }}>once Claude has drawn it</span></>
              ) : selectedId && models ? (
                <><b>No model named {selectedId}</b><span style={{ fontSize: 12 }}>Pick one from the library</span></>
              ) : (
                <><svg width="40" height="40" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M5 9 14 4l9 5v10l-9 5-9-5z" /><path d="M5 9l9 5 9-5M14 14v10" /></svg>
                  <b>{models ? "Pick a model from the library" : "Loading models…"}</b><span style={{ fontSize: 12 }}>or create one with Claude</span></>
              )}
            </div>
            <Toolbar actions={newModelActions} mode={null} theme={theme} toggleTheme={toggleTheme} />
          </>
        )}

        <div className="toasts centered" role="status" aria-live="polite">
          {route.left === "printer" && (
            <div className="toast"><span className="dot" style={{ background: stateColor }} />{printerCaption(live)}</div>
          )}
          {toasts.map((t) => (
            <div key={t.id} className={t.error ? "toast toast-error" : "toast"}>
              {!t.error && <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}><circle cx="12" cy="12" r="10" fill="var(--acc)" /><path d="m7.5 12.5 3 3 6-6" fill="none" stroke="var(--acc-ink)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              {t.msg}
            </div>
          ))}
        </div>
      </main>

      <div className="inspector-slot" ref={setInspectorSlot} />

      <aside className="panel side-panel left-panel" aria-label="Print Bay">
        <div className="panel-head drag">
          <div className="brand">
            <svg width="30" height="30" viewBox="0 0 28 28" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 9 14 4l9 5v10l-9 5-9-5z" /><path d="M5 9l9 5 9-5M14 14v10" />
            </svg>
            <div>
              <div className="brand-name">PRINT BAY</div>
              <div className="muted" style={{ fontSize: 12 }}>K2 Workspace · {n} {n === 1 ? "model" : "models"}</div>
            </div>
          </div>
          <div className="seg" role="tablist" aria-label="Section">
            <button role="tab" aria-selected={route.left === "printer"} onClick={() => go("/printer")}>Printer</button>
            <button role="tab" aria-selected={route.left !== "printer"}
              onClick={() => go(selectedId ? `/models/${encodeURIComponent(selectedId)}` : "/models")}>Models</button>
          </div>
        </div>
        <div className="panel-body" style={route.left === "create" ? { display: "flex", flexDirection: "column", overflow: "hidden" } : undefined}>
          {!models ? (
            <div className="sec muted">Loading…</div>
          ) : route.left === "printer" ? (
            <PrinterPanel live={live} models={models} toast={toast} openModel={openModel} />
          ) : route.left === "create" ? (
            <CreatePanel live={live} models={models} back={() => go("/models")} openModel={openModel} onModel={setCreated} toast={toast} />
          ) : (
            <ModelsPanel ref={search} models={models} selected={selectedId} open={openModel} create={() => go("/create")} />
          )}
        </div>
      </aside>
    </div>
  );
}
