import { useRef, useState } from "react";
import { api } from "../api";
import type { Rates, Repo, SettingsView, ToolName, ToolStatus } from "../types";

interface Props {
  settings: SettingsView;
  setSettings: (s: SettingsView) => void;
  /** first run: a welcome, and a button to finish */
  setup: boolean;
  toast: (msg: string, error?: boolean) => void;
}

const FROM: Record<string, string> = { env: "set by the environment", settings: "set here", found: "found", default: "default", missing: "" };

/** Setup on first run, Settings after: the printer, the library, the tools, and cost rates. */
export function SettingsPanel({ settings, setSettings, setup, toast }: Props) {
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
      <PrinterSection settings={settings} save={save} toast={toast} />
      <LibrarySection settings={settings} setup={setup} toast={toast} setSettings={setSettings} />
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

function PrinterSection({ settings, save, toast }: { settings: SettingsView; save: (b: object, done?: string) => Promise<boolean>; toast: Props["toast"] }) {
  const current = settings.printer.host?.replace(/:7125$/, "") ?? "";
  const [host, setHost] = useState(current);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fromEnv = settings.printer.source === "env";

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
    if (!host.trim()) { await save({ printer: null }, "Printer cleared."); return; }
    const found = await test();
    // an unreachable printer may just be off: save anyway, and say so
    if (await save({ printer: host }, found ? "Printer saved." : undefined) && !found) toast("Saved, but the printer didn't answer. Is it on?", true);
  };

  return (
    <div className="sec">
      <div className="sech">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 17h8M9 7h6v5H9z" /></svg>
        Printer
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.45 }}>
        The K2's IP address (on the printer: Settings → Network), or its host name. Give it a fixed address in your router so it doesn't change.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input className="field mono" value={host} placeholder="192.168.1.50" disabled={fromEnv} aria-label="Printer address"
          onChange={(e) => { setHost(e.target.value); setResult(null); }} onKeyDown={(e) => { if (e.key === "Enter" && !busy) testAndSave(); }} />
        <button className="cta cta-sm" style={{ padding: "0 12px", flex: "none" }} disabled={busy || fromEnv || !host.trim()} onClick={test}>{busy ? "Testing…" : "Test"}</button>
      </div>
      {result && <div style={{ fontSize: 12, marginTop: 8, color: result.ok ? "var(--ok)" : "var(--bad)" }}>{result.text}</div>}
      {fromEnv
        ? <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Set by K2_HOST in the environment.</div>
        : host.trim() !== current && (
          <button className="cta cta-md go" style={{ marginTop: 10 }} disabled={busy} onClick={testAndSave}>{host.trim() ? "Save printer" : "Clear printer"}</button>
        )}
    </div>
  );
}

function LibrarySection({ settings, setup, toast, setSettings }: Pick<Props, "settings" | "setup" | "toast" | "setSettings">) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
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
      <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>Your models, jobs, slicer profiles and rates. It's a git repository you can push from Changes.</div>
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
