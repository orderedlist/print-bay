import { useEffect, useRef, useState } from "react";
import { api, printerName, shortHost } from "../api";
import type { Rates, Repo, SavedPrinter, SettingsView, ToolName, ToolStatus, UpdateStatus } from "../types";

interface Props {
  settings: SettingsView;
  setSettings: (s: SettingsView) => void;
  /** first run: a welcome, and a button to finish */
  setup: boolean;
  /** the desktop app's updater; null in a browser or run from a checkout */
  update: UpdateStatus | null;
  toast: (msg: string, error?: boolean) => void;
}

const FROM: Record<string, string> = { env: "set by the environment", settings: "set here", found: "found", default: "default", missing: "" };

/** Setup on first run, Settings after: the printer, the library, the tools, and cost rates. */
export function SettingsPanel({ settings, setSettings, setup, update, toast }: Props) {
  // one save at a time, so a slower earlier answer can't overwrite a later one
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (body: object, done?: string): Promise<boolean> => {
    const next = queue.current.then(async () => {
      try { setSettings(await api<SettingsView>("/api/settings", { method: "PUT", json: body })); if (done) toast(done); return true; }
      catch (e) { toast((e as Error).message, true); return false; }
    });
    queue.current = next;
    return next;
  };
  const missingRequired = settings.tools.filter((t) => t.required && !t.ok);

  return (
    <>
      {setup && (
        <div className="sec">
          <h1 style={{ fontSize: 16 }}>Set up Print Bay</h1>
          <p className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.45 }}>
            Point it at your K2, check the programs it uses, and set what you pay for filament and power. You can change all of this later in Settings.
          </p>
        </div>
      )}
      {update && !setup && <UpdateSection update={update} toast={toast} />}
      <PrinterSection settings={settings} setSettings={setSettings} save={save} toast={toast} />
      <LibrarySection settings={settings} setup={setup} toast={toast} setSettings={setSettings} save={save} />
      <div className="sec">
        <div className="sech">Programs<span className="count">{settings.tools.filter((t) => t.ok).length}/{settings.tools.length}</span></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
          {settings.tools.map((t) => <ToolRow key={t.name} tool={t} save={save} />)}
        </div>
      </div>
      <RatesSection rates={settings.rates} save={save} />
      {setup && (
        <div className="sec">
          {missingRequired.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--warn)", marginBottom: 10 }}>
              Without {missingRequired.map((t) => t.label).join(" and ")} nothing can be sliced or printed. You can finish now and add {missingRequired.length > 1 ? "them" : "it"} later.
            </div>
          )}
          <button className="cta cta-md go" onClick={() => save({ setupDone: true }, "All set.")}>Start using Print Bay</button>
        </div>
      )}
    </>
  );
}

interface FoundPrinter { host: string; ip: string; hostname: string; state: string; k2: boolean }

function PrinterSection({ settings, setSettings, save, toast }: Pick<Props, "settings" | "setSettings" | "toast"> & { save: (b: object, done?: string) => Promise<boolean> }) {
  const saved = settings.printer.saved;
  const [host, setHost] = useState(saved.length ? "" : shortHost(settings.printer.host ?? ""));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<FoundPrinter[] | null>(null);
  const fromEnv = settings.printer.source === "env";
  const isSaved = (f: FoundPrinter) => saved.some((p) => p.host === f.host || p.name?.toLowerCase() === f.hostname.toLowerCase());
  const unsaved = found?.filter((f) => !isSaved(f));

  const scan = async () => {
    setScanning(true);
    try { setFound(await api<FoundPrinter[]>("/api/settings/scan-printers", { method: "POST" })); }
    catch (e) { toast((e as Error).message, true); }
    setScanning(false);
  };
  // no printer yet: look for one straight away
  useEffect(() => { if (!settings.printer.host && !fromEnv) void scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a saved printer is only switched to (it may be off: what's known about it stays); one found on the network is saved
  const use = async (p: SavedPrinter) => {
    try {
      await api("/api/printer/active", { method: "PUT", json: { host: p.host } });
      setSettings(await api<SettingsView>("/api/settings"));
      toast(`Using ${printerName(p)}.`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const add = (f: FoundPrinter) => save({ printer: f.host }, `Using ${f.hostname}.`);
  const forget = (p: SavedPrinter) => save({ forgetPrinter: p.host }, `Forgot ${printerName(p)}.`);
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ host: string; hostname: string; state: string; message: string }>("/api/settings/test-printer", { method: "POST", json: { host } });
      setResult({ ok: true, text: `Found ${r.hostname} (${r.state}${r.message ? `: ${r.message}` : ""})` });
      return true;
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); return false; }
    finally { setBusy(false); }
  };
  const testAndSave = async () => {
    const ok = await test();
    // an unreachable printer may just be off: save anyway, and say so
    if (await save({ printer: host }, ok ? "Printer saved." : undefined)) {
      if (!ok) toast("Saved, but the printer didn't answer. Is it on?", true);
      setHost("");
      setResult(null);
    }
  };

  return (
    <div className="sec">
      <div className="sech">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 17h8M9 7h6v5H9z" /></svg>
        {saved.length > 1 ? "Printers" : "Printer"}
        {!fromEnv && (
          <button className="link-btn" style={{ marginLeft: "auto", fontSize: 12, letterSpacing: 0, textTransform: "none" }} disabled={scanning} onClick={scan}>
            {scanning ? "Scanning…" : found ? "Scan again" : "Scan network"}
          </button>
        )}
      </div>
      {fromEnv ? (
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Set by K2_HOST in the environment: <span className="mono">{settings.printer.host}</span></div>
      ) : (
        <>
          {saved.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
              {saved.map((p) => (
                <div key={p.host} className="row" style={{ cursor: "default" }} aria-current={p.active}>
                  <span className="row-text">
                    <span className="row-title">{printerName(p)}</span>
                    <span className="row-sub">{p.name ? shortHost(p.host) : "hasn't answered yet"}</span>
                  </span>
                  {p.active
                    ? <span style={{ fontSize: 12, color: "var(--ok)", flex: "none" }}>In use</span>
                    : <button className="link-btn" style={{ fontSize: 12, flex: "none" }} aria-label={`Use ${printerName(p)}`} onClick={() => use(p)}>Use</button>}
                  <button className="ibtn" aria-label={`Forget ${printerName(p)}`} title="Forget" onClick={() => forget(p)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {scanning && !found && <div className="muted" style={{ fontSize: 12, marginTop: 10 }}><span className="spinner" style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 8 }} />Looking for printers on your network…</div>}
          {unsaved && unsaved.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
              {saved.length > 0 && <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Also on your network</div>}
              {unsaved.map((f) => (
                <button key={f.host} className="row" onClick={() => add(f)} title={`Use ${f.hostname}`}>
                  <span className="row-text">
                    <span className="row-title">{f.hostname}{f.k2 ? "" : " (not a K2?)"}</span>
                    <span className="row-sub">{f.ip} · {f.state}</span>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--acc)", flex: "none" }}>Use</span>
                </button>
              ))}
            </div>
          )}
          {found && found.length === 0 && (
            <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.45, color: "var(--warn)" }}>
              No printer answered on this network. Check the K2 is on and on the same Wi-Fi as this Mac, or type its IP address below (on the printer: Settings → Network).
            </div>
          )}
          {found && found.length > 0 && !unsaved?.length && (
            <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>Every printer on your network is saved.</div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.45 }}>
            {saved.length || found?.length ? "Or add one by address." : "Its IP address or host name."} When a printer gets a new address, Print Bay finds it again by name.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input className="field mono" value={host} placeholder="192.168.1.50" aria-label="Printer address"
              onChange={(e) => { setHost(e.target.value); setResult(null); }} onKeyDown={(e) => { if (e.key === "Enter" && !busy && host.trim()) testAndSave(); }} />
            <button className="cta cta-sm" style={{ padding: "0 12px", flex: "none" }} disabled={busy || !host.trim()} onClick={test}>{busy ? "Testing…" : "Test"}</button>
          </div>
          {result && <div style={{ fontSize: 12, marginTop: 8, color: result.ok ? "var(--ok)" : "var(--bad)" }}>{result.text}</div>}
          {host.trim() && (
            <button className="cta cta-md go" style={{ marginTop: 10 }} disabled={busy} onClick={testAndSave}>Save printer</button>
          )}
        </>
      )}
    </div>
  );
}

const LIBRARY_FROM: Record<SettingsView["library"]["source"], string> = {
  env: "Set by PRINT_BAY_DATA in the environment.",
  chosen: "Chosen in Settings.",
  checkout: "This copy of the Print Bay repo, which has its own models.",
  default: "The standard place on this Mac.",
};

function LibrarySection({ settings, setup, toast, setSettings, save }: Pick<Props, "settings" | "setup" | "toast" | "setSettings"> & { save: (b: object, done?: string) => Promise<boolean> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState<string | null>(null); // a path being typed, without the desktop folder picker
  const lib = settings.library;
  const choose = async () => {
    if (!settings.desktop.pickFolder) { setTyping(""); return; }
    try {
      const { path } = await api<{ path: string | null }>("/api/library/pick", { method: "POST" });
      if (path) await save({ library: path });
    } catch (e) { toast((e as Error).message, true); }
  };
  const restart = async () => {
    try { await api("/api/restart", { method: "POST" }); toast("Restarting…"); }
    catch (e) { toast((e as Error).message, true); }
  };
  const start = async () => {
    setBusy(true);
    try {
      await api<Repo[]>("/api/library/start-from-remote", { method: "POST", json: { url } });
      setSettings(await api<SettingsView>("/api/settings"));
      setUrl("");
      toast("Library copied from the remote.");
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  return (
    <div className="sec">
      <div className="sech">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
        Library
      </div>
      <div className="faint mono" style={{ fontSize: 11.5, marginTop: 8, wordBreak: "break-all" }}>{settings.library.path}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
        Your models, jobs, slicer profiles and rates. It's a git repository you can push from Changes. {LIBRARY_FROM[lib.source]}
      </div>
      {lib.source !== "env" && typing === null && (
        <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
          <button className="link-btn" style={{ fontSize: 12 }} onClick={choose}>Use another folder…</button>
          {lib.source === "chosen" && <button className="link-btn" style={{ fontSize: 12 }} onClick={() => save({ library: null })}>Back to the standard place</button>}
        </div>
      )}
      {typing !== null && (
        <div style={{ marginTop: 8 }}>
          <input className="field mono" style={{ fontSize: 12 }} value={typing} placeholder="/Users/you/Prints" aria-label="Library folder" autoFocus
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={async (e) => { if (e.key === "Enter" && typing.trim() && await save({ library: typing })) setTyping(null); if (e.key === "Escape") setTyping(null); }} />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="cta cta-sm" style={{ padding: "0 12px" }} disabled={!typing.trim()} onClick={async () => { if (await save({ library: typing })) setTyping(null); }}>Use it</button>
            <button className="cta cta-sm" style={{ padding: "0 12px" }} onClick={() => setTyping(null)}>Cancel</button>
          </div>
        </div>
      )}
      {lib.next && (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "var(--panel2)" }}>
          <div style={{ fontSize: 12, lineHeight: 1.45 }}>
            Print Bay opens <span className="mono" style={{ wordBreak: "break-all" }}>{lib.next}</span> the next time it starts.
            {" "}An empty or new folder becomes a new library.
          </div>
          {settings.desktop.restart
            ? <button className="cta cta-sm go" style={{ marginTop: 8, padding: "0 12px" }} onClick={restart}>Restart now</button>
            : <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Restart the server to switch.</div>}
        </div>
      )}
      {settings.library.fresh && settings.caps.git && (
        <>
          <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.45 }}>
            {setup ? "Starting empty. Or, to use a library you've pushed from another computer, give its remote:" : "It's empty. To use a library you've pushed from another computer, give its remote:"}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input className="field" value={url} placeholder="git@github.com:you/prints.git" aria-label="Library remote URL"
              onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim() && !busy) start(); }} />
            <button className="cta cta-sm" style={{ padding: "0 12px", flex: "none" }} disabled={!url.trim() || busy} onClick={start}>{busy ? "Copying…" : "Use it"}</button>
          </div>
        </>
      )}
    </div>
  );
}

function ToolRow({ tool, save }: { tool: ToolStatus; save: (b: object, done?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const fromEnv = tool.source === "env";
  const dot = tool.ok ? "var(--ok)" : tool.required ? "var(--bad)" : "var(--faint)";
  const set = async (p: string | null) => {
    if (await save({ tools: { [tool.name as ToolName]: p } }, p ? `${tool.label} saved.` : undefined)) setEditing(false);
  };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="dot" style={{ background: dot }} />
        <span style={{ fontWeight: 500 }}>{tool.label}</span>
        {!tool.required && <span className="faint" style={{ fontSize: 11 }}>optional</span>}
        <span className="spacer" />
        {!fromEnv && !editing && (
          <button className="link-btn" style={{ fontSize: 12 }} onClick={() => { setValue(tool.ok ? tool.path : ""); setEditing(true); }}>
            {tool.ok ? "Change" : "Set path"}
          </button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2, paddingLeft: 16 }}>{tool.purpose}</div>
      {tool.ok ? (
        <div className="faint mono" style={{ fontSize: 11, marginTop: 2, paddingLeft: 16, wordBreak: "break-all" }} title={FROM[tool.source]}>{tool.path}</div>
      ) : (
        <div style={{ fontSize: 12, marginTop: 4, paddingLeft: 16, lineHeight: 1.4 }}>
          <span style={{ color: tool.required ? "var(--bad)" : "var(--muted)" }}>{tool.problem}.</span> <span className="faint">{tool.install}</span>
        </div>
      )}
      {editing && (
        <div style={{ paddingLeft: 16, marginTop: 8 }}>
          <input className="field mono" style={{ fontSize: 12 }} value={value} placeholder="/full/path/to/the/program" aria-label={`Path to ${tool.label}`} autoFocus
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) set(value); if (e.key === "Escape") setEditing(false); }} />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="cta cta-sm" style={{ padding: "0 12px" }} disabled={!value.trim()} onClick={() => set(value)}>Save</button>
            {tool.source === "settings" && <button className="cta cta-sm" style={{ padding: "0 12px" }} onClick={() => set(null)}>Find it again</button>}
            <button className="cta cta-sm" style={{ padding: "0 12px" }} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const RATE_FIELDS: { key: keyof Rates; label: string; unit: string }[] = [
  { key: "filament_per_kg", label: "Filament", unit: "per kg" },
  { key: "power_per_kwh", label: "Electricity", unit: "per kWh" },
  { key: "printer_watts", label: "Printer draw", unit: "watts" },
];

function RatesSection({ rates, save }: { rates: Rates; save: (b: object, done?: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Record<keyof Rates, string>>(() =>
    Object.fromEntries(RATE_FIELDS.map((f) => [f.key, String(rates[f.key])])) as Record<keyof Rates, string>);
  const dirty = RATE_FIELDS.some((f) => Number(draft[f.key]) !== rates[f.key]);
  const valid = RATE_FIELDS.every((f) => draft[f.key].trim() !== "" && isFinite(Number(draft[f.key])) && Number(draft[f.key]) >= 0);
  return (
    <div className="sec">
      <div className="sech">Costs</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>For the cost of each print. Saved in the library's costs.toml.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {RATE_FIELDS.map((f) => (
          <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flexGrow: 1 }}>{f.label}</span>
            <span className="num wide">
              <input type="number" min="0" step="any" value={draft[f.key]} aria-label={`${f.label} ${f.unit}`}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              <span className="faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{f.unit}</span>
            </span>
          </label>
        ))}
      </div>
      {dirty && (
        <button className="cta cta-md go" style={{ marginTop: 10 }} disabled={!valid}
          onClick={() => save({ rates: Object.fromEntries(RATE_FIELDS.map((f) => [f.key, Number(draft[f.key])])) }, "Costs saved.")}>Save costs</button>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** The app's version and its updates from GitHub Releases: what's happening, and the button for it. */
function UpdateSection({ update: u, toast }: { update: UpdateStatus; toast: Props["toast"] }) {
  const [busy, setBusy] = useState(false);
  const post = async (what: "check" | "install") => {
    setBusy(true);
    try { await api(`/api/update/${what}`, { method: "POST" }); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  const line = u.state === "checking" ? "Checking for updates…"
    : u.state === "downloading" ? `Downloading ${u.available}…${u.percent ? ` ${u.percent}%` : ""}`
      : u.state === "ready" ? `${u.available} is ready. Restart to update, or it installs when you quit.`
        : u.state === "error" ? `Couldn't check for updates: ${u.error}`
          : u.state === "current" ? `Up to date${u.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ""}`
            : "Updates from GitHub Releases";
  return (
    <div className="sec">
      <div className="sech">
        Print Bay<span className="count">{u.version}</span>
      </div>
      <div className={u.state === "error" ? "" : "muted"} style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.45, color: u.state === "error" ? "var(--warn)" : undefined }}>
        {line}
      </div>
      {u.state === "ready" ? (
        <button className="cta cta-md go" style={{ marginTop: 12 }} disabled={busy} onClick={() => post("install")}>
          {busy ? "Restarting…" : `Restart to update to ${u.available}`}
        </button>
      ) : (
        <button className="cta cta-md" style={{ marginTop: 12 }} disabled={busy || u.state === "checking" || u.state === "downloading"} onClick={() => post("check")}>
          Check for updates
        </button>
      )}
    </div>
  );
}
