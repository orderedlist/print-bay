import { useEffect, useRef, useState } from "react";
import { api, colorName } from "../api";
import { slotName, type Printer, type PrinterConfig, type Rates, type Repo, type SettingsView, type Slot, type ToolName, type ToolStatus, type UpdateStatus } from "../types";
import { stateLabel } from "./PrinterPanel";

interface Props {
  settings: SettingsView;
  setSettings: (s: SettingsView) => void;
  /** first run: a welcome, and a button to finish */
  setup: boolean;
  /** the desktop app's updater; null in a browser or run from a checkout */
  update: UpdateStatus | null;
  toast: (msg: string, error?: boolean) => void;
  /** the printers' live status */
  printers: Printer[] | null;
}

const FROM: Record<string, string> = { env: "set by the environment", settings: "set here", found: "found", default: "default", missing: "" };

/** Setup on first run, Settings after: the printers, the library, the tools, and cost rates. */
export function SettingsPanel({ settings, setSettings, setup, update, toast, printers }: Props) {
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
            Add your printers, check the programs it uses, and set what you pay for filament and power. You can change all of this later in Settings.
          </p>
        </div>
      )}
      {update && !setup && <UpdateSection update={update} toast={toast} />}
      <PrintersSection settings={settings} setSettings={setSettings} live={printers} toast={toast} />
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

interface FoundPrinter { host: string; ip: string; hostname: string; state: string; k2: boolean; mac: string | null; slots: Slot[] }
interface Moved { id: string; name: string; from: string; to: string }
interface Draft { name: string; host: string; hostname?: string; mac?: string }

const bare = (host: string) => host.replace(/:7125$/, "");
const ICON_PRINTER = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 17h8M9 7h6v5H9z" /></svg>;

/** The spools a printer has loaded, as dots: the easiest way to tell two printers apart. */
function Spools({ slots }: { slots: Slot[] }) {
  if (!slots.length) return null;
  return (
    <span style={{ display: "flex", gap: 3, marginTop: 4 }} title={slots.map((s) => `${slotName(s.slot)}: ${colorName(s.color)}`).join(", ")}>
      {slots.map((s) => <span key={s.slot} className="dot" style={{ width: 9, height: 9, background: s.color, boxShadow: "0 0 0 1px var(--line) inset" }} />)}
    </span>
  );
}

/** The printers this computer prints to: found by a scan or typed in, each with a name. */
function PrintersSection({ settings, setSettings, live, toast }: { settings: SettingsView; setSettings: Props["setSettings"]; live: Printer[] | null; toast: Props["toast"] }) {
  const saved = settings.printers.list;
  const fromEnv = settings.printers.source === "env";
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<FoundPrinter[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // a printer's id, or "new"
  const [draft, setDraft] = useState<Draft>({ name: "", host: "" });

  const reload = async () => setSettings(await api<SettingsView>("/api/settings"));
  const scan = async () => {
    setScanning(true);
    try {
      const r = await api<{ found: FoundPrinter[]; moved: Moved[] }>("/api/settings/scan-printers", { method: "POST" });
      setFound(r.found);
      if (r.moved.length) {
        await reload();
        toast(r.moved.map((m) => `${m.name} moved to ${bare(m.to)}`).join(", ") + ". Updated.");
      }
    } catch (e) { toast((e as Error).message, true); }
    setScanning(false);
  };
  // no printer yet: look for one straight away
  useEffect(() => { if (!saved.length && !fromEnv) void scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startAdd = (d: Draft) => { setDraft(d); setEditing("new"); };
  const startEdit = (p: PrinterConfig) => { setDraft({ name: p.name, host: bare(p.host), hostname: p.hostname }); setEditing(p.id); };
  // printers saved before Print Bay remembered who they are, and not where they were: say which found one each is
  const unknown = saved.filter((p) => !p.mac && !p.hostname && !found?.some((f) => f.host === p.host));
  const claim = async (p: PrinterConfig, f: FoundPrinter) => {
    try {
      await api(`/api/settings/printers/${p.id}`, { method: "PUT", json: { host: f.host, hostname: f.hostname, mac: f.mac } });
      await reload();
      toast(`${p.name} is ${f.hostname}, at ${f.ip}. Print Bay will follow it if its address changes again.`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const statusOf = (id: string) => live?.find((p) => p.id === id)?.status;

  return (
    <div className="sec">
      <div className="sech">
        {ICON_PRINTER}
        Printers{saved.length > 0 && <span className="count" style={{ marginLeft: 6 }}>{saved.length}</span>}
        {!fromEnv && (
          <button className="link-btn" style={{ marginLeft: "auto", fontSize: 12, letterSpacing: 0, textTransform: "none" }} disabled={scanning} onClick={scan}>
            {scanning ? "Scanning…" : found ? "Scan again" : "Scan network"}
          </button>
        )}
      </div>
      {fromEnv && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Set by K2_HOST in the environment: <span className="mono">{saved[0]?.host}</span></div>}

      {saved.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
          {saved.map((p) => {
            const s = statusOf(p.id);
            const [label, color] = stateLabel(s?.state ?? "offline");
            return editing === p.id ? (
              <PrinterForm key={p.id} draft={draft} setDraft={setDraft} existing={p} done={async (msg) => { setEditing(null); await reload(); if (msg) toast(msg); }} toast={toast} />
            ) : (
              <button key={p.id} className="row" disabled={fromEnv} onClick={() => startEdit(p)} title={fromEnv ? undefined : `Rename, move or remove ${p.name}`}>
                <span className="dot" style={{ background: s ? color : "var(--faint)" }} />
                <span className="row-text">
                  <span className="row-title">{p.name}</span>
                  <span className="row-sub">{bare(p.host)}{p.hostname && p.hostname !== p.name ? ` · ${p.hostname}` : ""} · {s ? label.toLowerCase() : "…"}</span>
                  {s && <Spools slots={s.slots} />}
                </span>
                {!fromEnv && <span style={{ fontSize: 12, color: "var(--acc)", flex: "none" }}>Edit</span>}
              </button>
            );
          })}
        </div>
      )}

      {!fromEnv && (
        <>
          {scanning && !found && <div className="muted" style={{ fontSize: 12, marginTop: 10 }}><span className="spinner" style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 8 }} />Looking for printers on your network…</div>}
          {found && found.length > 0 && (
            <>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 14, textTransform: "uppercase", letterSpacing: ".04em" }}>On this network</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                {found.map((f) => {
                  const here = saved.find((p) => p.host === f.host);
                  const text = (
                    <span className="row-text">
                      <span className="row-title">{f.hostname}{f.k2 ? "" : " (not a K2?)"}</span>
                      <span className="row-sub">{f.ip} · {f.state}</span>
                      <Spools slots={f.slots} />
                    </span>
                  );
                  if (here) return (
                    <div key={f.host} className="row" aria-current style={{ cursor: "default" }}>
                      {text}
                      <span style={{ fontSize: 12, color: "var(--ok)", flex: "none" }}>{here.name === f.hostname ? "Added" : `Added as ${here.name}`}</span>
                    </div>
                  );
                  return (
                    <div key={f.host} className="row" style={{ cursor: "default", alignItems: "flex-start" }}>
                      {text}
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flex: "none" }}>
                        <button className="link-btn" style={{ fontSize: 12 }} onClick={() => startAdd({ name: f.hostname, host: f.ip, hostname: f.hostname, mac: f.mac ?? undefined })}>Add</button>
                        {unknown.map((p) => (
                          <button key={p.id} className="link-btn" style={{ fontSize: 12 }} onClick={() => claim(p, f)}
                            title={`${p.name} (last at ${bare(p.host)}) is this printer: use its new address`}>This is {p.name}</button>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {found && found.length === 0 && (
            <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.45, color: "var(--warn)" }}>
              No printer answered on this network. Check it's on and on the same Wi-Fi as this Mac, or add it by its IP address (on the printer: Settings → Network).
            </div>
          )}
          {editing === "new" ? (
            <PrinterForm draft={draft} setDraft={setDraft} done={async (msg) => { setEditing(null); await reload(); if (msg) toast(msg); }} toast={toast} />
          ) : (
            <button className="link-btn" style={{ fontSize: 12, marginTop: 12 }} onClick={() => startAdd({ name: "", host: "" })}>Add a printer by its address</button>
          )}
          <div className="faint" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.45 }}>
            Giving each printer a fixed address in your router keeps it from moving.
          </div>
        </>
      )}
    </div>
  );
}

/** Naming a printer and setting its address: a new one, or one already added (which can also be removed). */
function PrinterForm({ draft, setDraft, existing, done, toast }: {
  draft: Draft; setDraft: (d: Draft) => void; existing?: PrinterConfig;
  done: (message?: string) => Promise<void>; toast: Props["toast"];
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (d: Partial<Draft>) => { setDraft({ ...draft, ...d }); if (d.host !== undefined) setResult(null); };

  const test = async (): Promise<string | null> => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ host: string; hostname: string; state: string; message: string }>("/api/settings/test-printer", { method: "POST", json: { host: draft.host } });
      setResult({ ok: true, text: `Found ${r.hostname} (${r.state}${r.message ? `: ${r.message}` : ""})` });
      return r.hostname;
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); return null; }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const hostChanged = !existing || bare(existing.host) !== draft.host.trim();
    // an unreachable printer may just be off: save anyway, and say so
    const hostname = hostChanged ? await test() : null;
    const name = draft.name.trim() || hostname || draft.hostname || "";
    setBusy(true);
    try {
      // a new address may be another printer: forget its MAC (unless the scan just read it), and learn it again from the printer
      const body = { name, host: draft.host, ...(hostname ? { hostname } : hostChanged ? { hostname: null } : {}), ...(hostChanged ? { mac: draft.mac ?? null } : {}) };
      if (existing) await api(`/api/settings/printers/${existing.id}`, { method: "PUT", json: body });
      else await api("/api/settings/printers", { method: "POST", json: body });
      if (hostChanged && !hostname) toast(`Saved ${name}, but it didn't answer. Is it on?`, true);
      await done(hostChanged && !hostname ? undefined : existing ? `${name} saved.` : `Added ${name}.`);
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await api(`/api/settings/printers/${existing!.id}`, { method: "DELETE" }); await done(`Removed ${existing!.name}.`); }
    catch (e) { toast((e as Error).message, true); setBusy(false); }
  };

  return (
    <div className="tile" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <label className="muted" style={{ fontSize: 12 }}>Name
        <input className="field" style={{ marginTop: 4 }} value={draft.name} placeholder={draft.hostname ?? "Left K2"} autoFocus aria-label="Printer name"
          onChange={(e) => set({ name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }} />
      </label>
      <label className="muted" style={{ fontSize: 12 }}>Address
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input className="field mono" value={draft.host} placeholder="192.168.1.50" aria-label="Printer address"
            onChange={(e) => set({ host: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }} />
          <button className="cta cta-sm" style={{ padding: "0 12px", flex: "none" }} disabled={busy || !draft.host.trim()} onClick={test}>{busy ? "Testing…" : "Test"}</button>
        </div>
      </label>
      {result && <div style={{ fontSize: 12, color: result.ok ? "var(--ok)" : "var(--bad)" }}>{result.text}</div>}
      <div className="grid2" style={{ marginTop: 4 }}>
        <button className="cta cta-md" disabled={busy} onClick={() => done()}>Cancel</button>
        <button className="cta cta-md go" disabled={busy || !draft.host.trim() || (!draft.name.trim() && !draft.hostname)} onClick={submit}>{existing ? "Save" : "Add printer"}</button>
      </div>
      {existing && (
        <button className="cta cta-sm danger" style={{ alignSelf: "flex-start", height: 28 }} disabled={busy}
          onClick={() => (confirmRemove ? remove() : setConfirmRemove(true))}>
          {confirmRemove ? `Remove ${existing.name} and its queue?` : "Remove printer"}
        </button>
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
