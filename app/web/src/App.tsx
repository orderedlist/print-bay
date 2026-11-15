import { useCallback, useEffect, useRef, useState } from "react";
import { useLive, useModels, useRepos, useSettings } from "./api";
import { Camera } from "./components/Camera";
import { ICONS, Toolbar } from "./components/Toolbar";
import { ChangesPanel } from "./screens/ChangesPanel";
import { CreatePanel } from "./screens/CreatePanel";
import { ModelsPanel } from "./screens/ModelsPanel";
import { ModelWorkspace, type InspectorTab } from "./screens/ModelWorkspace";
import { PrinterPanel, printerCaption, stateLabel } from "./screens/PrinterPanel";
import { SettingsPanel } from "./screens/SettingsPanel";
import { useTheme } from "./theme";

// #/printer (the default), #/models, #/models/<id>, #/create, #/changes, #/settings. Older links still work.
type Route = { left: "printer" } | { left: "models"; id: string | null } | { left: "create" } | { left: "changes" } | { left: "settings" };

function parseRoute(hash: string): Route {
  const [, screen, id] = hash.split("/");
  if (screen === "models" || screen === "model") return { left: "models", id: id ? decodeURIComponent(id) : null };
  if (screen === "library") return { left: "models", id: null };
  if (screen === "create" || screen === "new") return { left: "create" };
  if (screen === "changes") return { left: "changes" };
  if (screen === "settings" || screen === "setup") return { left: "settings" };
  return { left: "printer" };
}

interface Toast { id: number; msg: string; error: boolean }

const LEFT_W = 300, RIGHT_W = 320, GAP = 14;

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
  const [repos, setRepos] = useRepos(live.modelsVersion);
  const changed = repos?.reduce((n, r) => n + r.changes.length, 0) ?? 0;
  const [settings, setSettings] = useSettings();
  const caps = settings?.caps ?? { slice: true, openscad: true, claude: true, git: true, nurb: true }; // until it loads
  const setup = !!settings?.needsSetup; // first run: Setup takes over the left panel
  const [theme, toggleTheme] = useTheme();
  const narrow = useNarrow();
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [tab, setTab] = useState<InspectorTab>("print");
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

  const selectedId = route.left === "models" && !setup ? route.id : null;
  const selected = selectedId ? models?.find((m) => m.id === selectedId) : undefined;
  const creating = route.left === "create" && !setup && caps.claude;
  const rightW = selected || creating ? RIGHT_W : 0;
  const shift = narrow ? 0 : ((LEFT_W + GAP) - (rightW ? rightW + GAP : 0)) / 2;
  const [, stateColor] = stateLabel(live.status?.state ?? "offline");
  const newModelActions = caps.claude ? [{ label: "New model with Claude", icon: ICONS.plus, run: () => go("/create") }] : [];
  const showSettings = setup || route.left === "settings";
  const n = models?.length ?? 0;

  return (
    <div className={`ws${rightW ? " with-inspector" : ""}`}>
      <main className="stage-area" aria-label="Stage">
        {showSettings ? (
          <div className="stage-hint">
            <svg width="40" height="40" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M5 9 14 4l9 5v10l-9 5-9-5z" /><path d="M5 9l9 5 9-5M14 14v10" /></svg>
            <b>{setup ? "Welcome to Print Bay" : "Settings"}</b>
            <span style={{ fontSize: 12 }}>{setup ? "A workspace for your Creality K2: models, slicing and printing" : "For this computer and its printer"}</span>
          </div>
        ) : route.left === "printer" ? (
          <Camera openSettings={() => go("/settings")} />
        ) : selected ? (
          <ModelWorkspace key={selected.id} model={selected} live={live} caps={caps} tab={tab} setTab={setTab} theme={theme} toggleTheme={toggleTheme}
            shift={shift} inspectorSlot={inspectorSlot} close={() => go("/models")} goPrinter={() => go("/printer")} newModel={() => go("/create")} toast={toast} />
        ) : (
          <>
            <div className="stage-hint">
              {route.left === "changes" ? (
                <><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" /></svg>
                  <b>Commit and push your changes</b><span style={{ fontSize: 12 }}>Models and settings in the library, code in the app</span></>
              ) : route.left === "create" ? (
                <><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
                  <b>Describe the part to Claude</b><span style={{ fontSize: 12 }}>It shows up here once it's drawn</span></>
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
          {route.left === "printer" && !showSettings && (
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
      {creating && (
        <CreatePanel live={live} close={() => go("/models")} toast={toast}
          created={(id) => { setTab("claude"); openModel(id); }} />
      )}

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
            {!setup && (
              <button className="ibtn" style={{ marginLeft: "auto" }} aria-label="Settings" title="Settings" aria-pressed={route.left === "settings"}
                onClick={() => go(route.left === "settings" ? "/printer" : "/settings")}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
              </button>
            )}
          </div>
          {!setup && <div className="seg" role="tablist" aria-label="Section">
            <button role="tab" aria-selected={route.left === "printer"} onClick={() => go("/printer")}>Printer</button>
            <button role="tab" aria-selected={route.left === "models" || route.left === "create"}
              onClick={() => go(selectedId ? `/models/${encodeURIComponent(selectedId)}` : "/models")}>Models</button>
            {caps.git && (
              <button role="tab" aria-selected={route.left === "changes"} onClick={() => go("/changes")}
                aria-label={changed ? `Changes, ${changed} uncommitted` : "Changes"}>
                Changes{changed > 0 && <span className="badge-n" style={{ marginLeft: 6 }}>{changed > 99 ? "99+" : changed}</span>}
              </button>
            )}
          </div>}
        </div>
        <div className="panel-body">
          {showSettings ? (
            settings ? <SettingsPanel settings={settings} setSettings={setSettings} setup={setup} toast={toast} /> : <div className="sec muted">Loading…</div>
          ) : !models ? (
            <div className="sec muted">Loading…</div>
          ) : route.left === "printer" ? (
            <PrinterPanel live={live} models={models} toast={toast} openModel={openModel} />
          ) : route.left === "changes" ? (
            repos ? <ChangesPanel repos={repos} setRepos={setRepos} toast={toast} /> : <div className="sec muted">Loading…</div>
          ) : (
            <ModelsPanel ref={search} models={models} selected={selectedId} open={openModel} create={caps.claude ? () => go("/create") : null} />
          )}
        </div>
      </aside>
    </div>
  );
}
