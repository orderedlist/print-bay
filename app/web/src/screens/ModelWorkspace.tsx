import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as THREE from "three";
import { api, colorName, duration, inches, kindLabel, money, title, useAgentSession, type Live } from "../api";
import { AgentPanel } from "../components/AgentPanel";
import { ModelViewer, SEVERITY_COLORS, type ViewAvailability, type ViewMode } from "../components/ModelViewer";
import { Params } from "../components/Params";
import { ICONS, Toolbar, type Action } from "../components/Toolbar";
import type { Theme } from "../theme";
import { IDLE_STATES, type AgentSession, type Caps, type CheckReport, MATERIAL_NAMES, type Material, type Model, type Printer, type ScadParam, slotName } from "../types";
import { plateFit } from "../plate";
import { PrinterSwitch, printerSummary, stateLabel } from "./PrinterPanel";

// Common revisions, offered as starting points in the Claude tab.
const EDIT_STARTERS = [
  "Make it stronger where it's weakest",
  "Add a 1 mm chamfer to the outside edges",
  "Make it print without supports",
  "Cut the print time without making it weaker",
  "It's too loose: tighten the fit by 0.2 mm",
];

export type InspectorTab = "print" | "design" | "claude";

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
    <div className="source">
      {bullets.length > 0 && <ul>{bullets.map((b, i) => <li key={i}>{inline(b.slice(2))}</li>)}</ul>}
      {prose.map((p, i) => <p key={i} style={{ margin: "8px 0 0" }}>{inline(p)}</p>)}
    </div>
  );
}

const Chevron = () => (
  <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);

/** A collapsible inspector section. */
/** A collapsible inspector section. `action` sits at the right of the header, outside its toggle. */
function Section({ icon, label, open, toggle, children, extra, action }: {
  icon?: ReactNode; label: string; open?: boolean; toggle?: () => void; children: ReactNode; extra?: ReactNode; action?: ReactNode;
}) {
  const head = toggle
    ? <button className="sech" aria-expanded={open} onClick={toggle}>{icon}{label}{extra}<Chevron /></button>
    : <div className="sech">{icon}{label}{extra}</div>;
  return (
    <div className="sec">
      {action ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{head}{action}</div> : head}
      {(open ?? true) && <div className="sec-body">{children}</div>}
    </div>
  );
}

interface Props {
  model: Model;
  live: Live;
  printer: Printer | null; // the one to print on
  pickPrinter: (id: string) => void;
  caps: Caps; // what's set up on this computer: no Claude Code, no Claude tab
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  theme: Theme;
  toggleTheme: () => void;
  shift: number;
  /** where the inspector goes: beside the stage, not on it, so it can stack below on a phone */
  inspectorSlot: HTMLElement | null;
  close: () => void;
  /** Open another model (this one, under its new name after a rename). */
  openModel: (id: string) => void;
  goPrinter: () => void;
  newModel: () => void;
  toast: (msg: string, error?: boolean) => void;
  /** The part being viewed (a job of a multi-part model); kept by App, so it's still there after visiting another tab. */
  jobName: string | null;
  setJobName: (job: string | null) => void;
}

/** A selected model: on the stage, with the bottom toolbar and the inspector beside it. */
export function ModelWorkspace({ model, live, printer, pickPrinter, caps, tab, setTab, theme, toggleTheme, shift, inspectorSlot, close, openModel, goPrinter, newModel, toast, jobName, setJobName }: Props) {
  // ---- renaming and deleting the model ----
  const [newName, setNewName] = useState<string | null>(null); // the name being typed, while renaming
  const [removing, setRemoving] = useState(false); // the delete dialog is open
  const [libBusy, setLibBusy] = useState(false);
  const rename = async () => {
    const name = newName?.trim();
    if (!name || name === title(model.id)) { setNewName(null); return; }
    setLibBusy(true);
    try {
      const r = await api<{ id: string }>(`/api/models/${encodeURIComponent(model.id)}/rename`, { method: "POST", json: { name } });
      setNewName(null);
      openModel(r.id);
    } catch (e) { toast((e as Error).message, true); }
    setLibBusy(false);
  };
  const remove = async () => {
    setLibBusy(true);
    try {
      await api(`/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      toast(`Moved ${title(model.id)} to the Trash.`);
      close();
    } catch (e) { toast((e as Error).message, true); setRemoving(false); }
    setLibBusy(false);
  };
  // a multi-part model (labelled jobs, say a plant and its pot) prints one part at a time
  const job = model.jobs.find((j) => j.name === jobName) ?? model.jobs[0];
  const partGroups = pickerGroups(model.jobs);
  // ---- plates: several parts printed at once ----
  const plateParts = model.jobs.filter((j) => !j.plate && j.label); // what can go on a plate
  const [plateBusy, setPlateBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [jobName]);
  const plateCall = async (fn: () => Promise<unknown>) => {
    setPlateBusy(true);
    try { await fn(); } catch (e) { toast((e as Error).message, true); }
    setPlateBusy(false);
  };
  const newPlate = () => plateCall(async () => {
    const start = job && !job.plate && job.label ? job : plateParts[0];
    const r = await api<{ name: string }>(`/api/models/${model.id}/plates`, { method: "POST", json: { counts: { [start.name]: 1 } } });
    setJobName(r.name);
    setTab("print");
  });
  // A plate's counts change on the click; the save follows once the clicks stop, and the
  // draft gives way when the saved plate comes back from the server.
  const savedCounts: Record<string, number> = Object.fromEntries((job?.plate ?? []).map((p) => [p.job, p.count]));
  const [draft, setDraft] = useState<{ plate: string; counts: Record<string, number> } | null>(null);
  const counts = draft && draft.plate === job?.name ? draft.counts : savedCounts;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { // the server has it: drop the draft
    if (draft && draft.plate === job?.name && Object.entries(draft.counts).every(([k, n]) => (savedCounts[k] ?? 0) === n)) setDraft(null);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  const setOnPlate = (part: string, n: number) => {
    if (!job?.plate) return;
    const next = { plate: job.name, counts: { ...counts, [part]: n } };
    setDraft(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api(`/api/plates/${next.plate}`, { method: "PUT", json: { counts: next.counts } })
        .catch((e) => { toast((e as Error).message, true); setDraft(null); });
    }, 350);
  };
  const deletePlate = () => job?.plate && plateCall(async () => {
    await api(`/api/plates/${job.name}`, { method: "DELETE" });
    setJobName(null);
  });
  const drawn = !!model.file; // a model Claude is still creating has only its folder
  const parametric = model.kind === "scad" || model.kind === "py"; // OpenSCAD, or a nurb part
  const canEdit = parametric || !drawn;
  const status = printer?.status ?? null;
  const several = (live.printers?.length ?? 0) > 1;
  const queued = live.queue.entries.filter((e) => e.printer === printer?.id).length;
  const [mode, setMode] = useState<ViewMode>("model");
  const [available, setAvailable] = useState<ViewAvailability>({ model: true, paths: false, stress: false, layout: false });
  const [size, setSize] = useState<THREE.Vector3 | null>(null);
  const [open, setOpen] = useState({ dims: true, checks: true, params: true, notes: false });
  const flip = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [units, setUnits] = useUnits();

  // ---- printability checks, on the model as it will be sliced ----
  const [checks, setChecks] = useState<CheckReport | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let alive = true;
    if (!drawn) { setChecks(null); setChecking(false); return; }
    setChecking(true);
    api<CheckReport>(`/api/models/${model.id}/checks${job ? `?job=${encodeURIComponent(job.name)}` : ""}`)
      .then((r) => alive && setChecks(r))
      .catch(() => alive && setChecks(null))
      .finally(() => alive && setChecking(false));
    return () => { alive = false; };
  }, [model.id, model.meshKey, live.modelsVersion, drawn, job?.name]);
  const issues = checks ? checks.findings.filter((f) => f.severity !== "info").length : 0;

  useEffect(() => { if (!caps.claude && tab === "claude") setTab("print"); }, [caps.claude, tab, setTab]);

  // ---- Claude ----
  const [agentId, setAgentId] = useState<string | null>(null);
  const session = useAgentSession(agentId, live);
  useEffect(() => { // the model's last chat, so a running edit or review shows up in the Claude tab
    api<AgentSession | null>(`/api/models/${model.id}/agent`).then((s) => s && setAgentId(s.id)).catch(() => {});
  }, [model.id]);
  const openAgent = async (fresh = false): Promise<AgentSession | null> => {
    setTab("claude");
    try {
      const existing = fresh ? null : await api<AgentSession | null>(`/api/models/${model.id}/agent`);
      const s = existing ?? await api<AgentSession>("/api/agent", { method: "POST", json: { kind: "edit", modelId: model.id } });
      setAgentId(s.id);
      return s;
    } catch (e) { toast((e as Error).message, true); return null; }
  };
  useEffect(() => { if (tab === "claude" && caps.claude && canEdit && !agentId) openAgent(); }, [tab, agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  /** "Analyze and correct": a review pass by Claude using every rule it knows plus the checks. */
  const analyze = async () => {
    const s = await openAgent();
    if (!s) return;
    if (s.running) { toast("Claude is still working on the last message", true); return; }
    api(`/api/agent/${s.id}/review`, { method: "POST" }).catch((e) => toast(e.message, true));
  };

  // ---- slicing ----
  const log = job ? live.slice[job.name] ?? [] : [];
  const slicing = !!job && (job.slicing || log.at(-1)?.state === "running");
  const [perPlate, setPerPlate] = useState(1); // copies laid out on one plate
  const slice = () => job && api(`/api/jobs/${job.name}/slice`, { method: "POST", json: { perPlate, material, oneColor, printer: printer?.id } }).catch((e) => toast(e.message, true));

  // ---- parameters ----
  const [params, setParams] = useState<ScadParam[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!job || !canEdit) { setParams([]); return; }
    api<ScadParam[]>(`/api/jobs/${job.name}/params`).then((p) => { setParams(p); setEdits({}); }).catch(() => setParams([]));
  }, [job?.name, canEdit, live.modelsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = (p: ScadParam) => edits[p.name] ?? p.value;
  const dirty = params.some((p) => p.name in edits && edits[p.name].trim() !== p.value);
  const atDefaults = params.every((p) => value(p).trim() === p.default);
  const saveAndSlice = async () => {
    if (!job) return;
    setSaving(true);
    try {
      const values = Object.fromEntries(params.map((p) => [p.name, value(p)]));
      await api(`/api/jobs/${job.name}/params`, { method: "PUT", json: { values } });
      await api(`/api/jobs/${job.name}/slice`, { method: "POST", json: { printer: printer?.id } });
    } catch (e) { toast((e as Error).message, true); }
    setSaving(false);
  };

  // ---- printing ----
  const slots = status?.slots ?? [];
  // one spool per colour: the whole job, or each part of a multi-colour job
  const colorways = job?.parts.length ? job.parts.map((p) => ({ key: p.name, label: p.name, hex: p.hex }))
    : [{ key: "", label: "", hex: job?.hex ?? null }];
  const multi = colorways.length > 1;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [copies, setCopies] = useState(job?.copies ?? 1);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [materialPick, setMaterialPick] = useState<Material | null>(null); // null: as the printer has the spool set
  useEffect(() => { setPicked({}); setCopies(job?.copies ?? 1); setMaterialPick(null); }, [job?.name]); // a different part: its own colour and count
  useEffect(() => { setPicked({}); setMaterialPick(null); }, [printer?.id]); // another printer has its own spools
  useEffect(() => { // default to the spool nearest the job's color, once the printer reports them
    const missing = colorways.filter((c) => !picked[c.key]);
    if (missing.length && slots.length)
      setPicked((p) => ({ ...p, ...Object.fromEntries(missing.map((c) => [c.key, nearest(c.hex, slots)]).filter(([, s]) => s)) }));
  }, [slots, job?.name, job?.hex, job?.parts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenFor = (key: string) => slots.find((s) => s.slot === picked[key]);
  const chosenAll = colorways.map((c) => chosenFor(c.key));
  const chosen = chosenAll.every(Boolean) ? chosenAll[0] : undefined;
  // wood fill and silk slice with their own filament profiles; one copy to a plate only
  const outside = chosenAll.some((s) => s?.slot === "EXT");
  const spoolMaterial: Material = chosenAll.find((s) => s && s.material !== "pla")?.material ?? "pla";
  const material: Material = perPlate > 1 ? "pla" : materialPick ?? spoolMaterial;
  // every part from the same spool: it slices as one colour, with no swaps
  const oneColor = multi && !!chosen && new Set(chosenAll.map((s) => s!.slot)).size === 1;
  const sliced = oneColor ? job?.oneColor?.[material] : material === "pla" ? job : job?.materials[material];
  const stale = !!sliced?.stale;
  const colorsText = (oneColor ? chosenAll.slice(0, 1) : chosenAll).map((c) => (c ? colorName(c.color).toLowerCase() : "?")).join(" and ") + (material === "pla" ? "" : ` ${material}`);
  const idle = status ? IDLE_STATES.has(status.state) : false;
  // how many fit on one plate (OpenSCAD models: the slicer lays them out), from the size as printed
  const fit = parametric && checks ? plateFit(checks.size[0], checks.size[1], multi) : 1;
  useEffect(() => { if (perPlate > fit) setPerPlate(fit); }, [fit]); // eslint-disable-line react-hooks/exhaustive-deps
  const plate = perPlate > 1 ? job?.plates.find((p) => p.perPlate === perPlate) : undefined;
  const exact = perPlate === 1 ? sliced?.stats : plate && !plate.stale ? plate.stats : null;
  // the viewer's toolpaths: this slice's, once it's sliced (several to a plate slice as PLA, as printing does)
  const sliceChoice = { perPlate, material, oneColor, slicedAt: (perPlate > 1 ? plate?.stats : sliced?.stats)?.slicedAt ?? null, printer: printer?.id ?? null };
  // until this plate is sliced, draw a line through the nearest counts that are: plates share
  // travel and colour swaps, so one copy times n would overestimate badly
  const stats = exact ?? (job?.stats && perPlate > 1 ? interpolate(perPlate, [
    { n: 1, stats: job.stats },
    ...job.plates.filter((p) => p.stats && !p.stale).map((p) => ({ n: p.perPlate, stats: p.stats! })),
  ]) : null);
  const estimated = !!stats && !exact;
  // slice the plate as soon as the count settles, so the real time replaces the estimate
  const failed = log.at(-1)?.state === "failed";
  useEffect(() => {
    if ((perPlate <= 1 && !oneColor) || exact || slicing || failed || !job) return; // after a failure, wait for "Try again"
    const t = setTimeout(slice, 1200);
    return () => clearTimeout(t);
  }, [perPlate, oneColor, !!exact, slicing]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = perPlate * copies;
  const submit = async (startNow: boolean) => {
    if (!job || !chosen || !printer) return;
    setConfirm(false);
    setSending(true);
    try {
      const r = await api<{ started: boolean; queued: number }>("/api/print", {
        method: "POST", json: multi
          ? { printer: printer.id, job: job.name, colors: Object.fromEntries(colorways.map((c, i) => [c.key, chosenAll[i]!.color])),
            slots: Object.fromEntries(colorways.map((c, i) => [c.key, chosenAll[i]!.slot])), copies, perPlate, material, startNow }
          : { printer: printer.id, job: job.name, color: chosen.color, slot: chosen.slot, copies, perPlate, material, startNow },
      });
      const what = `${title(model.id)}${job.label ? ` (${job.label})` : ""} in ${colorsText}${several ? ` on ${printer.name}` : ""}`;
      toast(r.started
        ? `Started ${what}.${r.queued ? ` ${r.queued} more ${r.queued === 1 ? "copy" : "copies"} queued.` : ""}`
        : `Queued ${r.queued} × ${what}.`);
    } catch (e) { toast((e as Error).message, true); }
    setSending(false);
  };
  const print = () => {
    setTab("print");
    if (!job || !chosen || sending) return;
    if (idle) setConfirm(true);
    else submit(false);
  };
  const total = stats ? `${estimated ? "≈ " : ""}${duration(stats.seconds * copies)}` : null;
  const ctaLabel = sending ? (stale ? "Slicing & sending…" : "Sending…")
    : `${idle ? "Print" : "Queue"}${count > 1 ? ` ${count}` : ""}${total ? ` · ${total}` : stale ? " · slices first" : ""}`;

  const actions: Action[] = [
    { label: "Print…", icon: ICONS.print, run: print, disabled: !job || !chosen, accent: true },
    { label: slicing ? "Slicing…" : caps.slice ? "Re-slice" : "Re-slice (set up OrcaSlicer in Settings)", icon: ICONS.slice, run: slice, disabled: !job || slicing || !caps.slice },
    ...(caps.claude ? [
      { label: "Analyze and correct", icon: ICONS.spark, run: analyze, disabled: !canEdit || session?.running, accent: true },
      { label: "New model with Claude", icon: ICONS.plus, run: newModel },
    ] : []),
  ];

  const [stateText, stateColor] = stateLabel(status?.state ?? "offline");
  const running = status?.state === "printing" || status?.state === "paused";

  return (
    <>
      {drawn ? (
        <ModelViewer model={model} job={job} mode={mode} setMode={setMode} theme={theme} shift={shift}
          onSize={setSize} onAvailable={setAvailable} checks={checks} slice={sliceChoice}
          colors={colorways.map((c, i) => chosenAll[i]?.color ?? c.hex ?? "").filter(Boolean)} />
      ) : (
        <div className="stage-hint">
          {session?.running ? <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} /> : ICONS.spark}
          <b>{session?.running ? "Claude is working on it" : "Not drawn yet"}</b>
          <span style={{ fontSize: 12 }}>{session?.running ? "It shows up here once it's drawn" : "Answer Claude in the Claude tab"}</span>
        </div>
      )}
      <Toolbar actions={actions} mode={drawn ? mode : null} available={available} setMode={setMode} theme={theme} toggleTheme={toggleTheme} />

      {inspectorSlot && createPortal(<aside className="panel side-panel inspector" aria-label={title(model.id)}>
        <div className="panel-head drag" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="row status-chip" onClick={goPrinter} title="Open the printer">
              <span className="ico">{ICONS.print}</span>
              <span className="row-text">
                <span style={{ fontSize: 12, fontWeight: 500 }}>{printer?.name ?? "No printer"} · {stateText}</span>
                <span className="row-sub" style={{ color: "var(--muted)" }}>
                  {!printer ? "add one in Settings" : running || !status?.online || queued ? printerSummary(printer, queued) : "ready"}
                </span>
              </span>
              <span className="dot" style={{ background: stateColor }} />
            </button>
            <button className="ibtn" onClick={close} aria-label="Close model" title="Close model">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <div className="seg" role="tablist" aria-label="Inspector">
            <button role="tab" aria-selected={tab === "print"} onClick={() => setTab("print")}>
              Print{issues > 0 && <span className="badge-n" aria-label={`${issues} check findings`}>{issues}</span>}
            </button>
            <button role="tab" aria-selected={tab === "design"} onClick={() => setTab("design")}>Design</button>
            {caps.claude && (
              <button role="tab" aria-selected={tab === "claude"} onClick={() => setTab("claude")}>
                Claude{session?.running && <span className="spinner" aria-label="working" />}
              </button>
            )}
          </div>
        </div>

        <div className="sec">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            {newName !== null ? (
              <form className="rename" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                <label className="sr-only" htmlFor="model-name">Model name</label>
                <input id="model-name" autoFocus value={newName} disabled={libBusy} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setNewName(null); }} onFocus={(e) => e.target.select()} />
                <button type="submit" className="cta cta-sm go" disabled={libBusy || !newName.trim()}>{libBusy ? "Renaming…" : "Rename"}</button>
                <button type="button" className="cta cta-sm" disabled={libBusy} onClick={() => setNewName(null)}>Cancel</button>
              </form>
            ) : <>
              <h1 style={{ fontSize: 16 }}>{title(model.id)}</h1>
              <span className="faint" style={{ fontSize: 12 }}>{kindLabel(model.kind)}</span>
              {job?.stale && job.stats && <span style={{ fontSize: 12, color: "var(--warn)" }}>changed since slice</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignSelf: "center" }}>
                <button className="ibtn" onClick={() => setNewName(title(model.id))} aria-label="Rename model" title="Rename">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
                </button>
                <button className="ibtn" onClick={() => setRemoving(true)} aria-label="Delete model" title="Delete">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                </button>
              </span>
            </>}
          </div>
          {partGroups && (
            <div className="parts" role="radiogroup" aria-label="Part to print">
              {partGroups.map((g) => {
                const buttons = g.jobs.map(({ job: j, short }) => (
                  <button key={j.name} role="radio" aria-checked={j.name === job?.name} aria-label={j.label ?? j.name}
                    title={j.stats ? `${j.label} · ${j.stats.time}` : `${j.label} · not sliced`} onClick={() => setJobName(j.name)}>
                    {j.hex && <span className="swatch" style={{ background: j.hex }} />}<span className="seg-text">{short}</span>
                  </button>
                ));
                // named ones (no number to group them by) each get a line of their own
                return g.name === null
                  ? <div key={g.jobs[0].job.name} className="seg seg-sm seg-col">{buttons}</div>
                  : <div key={g.name} className="parts-row"><span className="faint">{g.name}</span><div className="seg seg-sm">{buttons}</div></div>;
              })}
              {plateParts.length > 1 && (
                <button className="cta cta-sm" style={{ justifySelf: "start", height: 28 }} disabled={plateBusy} onClick={newPlate}
                  title="Print several parts at once, laid out on one bed">+ New plate</button>
              )}
            </div>
          )}
        </div>

        {tab === "print" && (
          <div className="panel-body">
            <Section label="Dimensions" open={open.dims} toggle={() => flip("dims")}
              action={<div className="seg seg-sm" role="radiogroup" aria-label="Units" style={{ padding: 2, flex: "none" }}>
                {(["mm", "in"] as const).map((u) => (
                  <button key={u} role="radio" aria-checked={units === u} onClick={() => setUnits(u)} style={{ height: 22, padding: "0 8px", fontSize: 11.5 }}>{u}</button>
                ))}
              </div>}
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 8 12 4l8 4v8l-8 4-8-4z" /></svg>}>
              <div className="grid3">
                {(["x", "y", "z"] as const).map((k) => (
                  <div key={k} className="box mono" title={size ? (units === "in" ? `${size[k].toFixed(1)} mm` : inches(size[k])) : undefined}>
                    <span>{k.toUpperCase()}</span><span>{size ? (units === "in" ? `${(size[k] / 25.4).toFixed(2)}″` : size[k].toFixed(1)) : "…"}</span>
                  </div>
                ))}
              </div>
            </Section>

            {job?.plate && (
              <Section label={`On ${job.label ?? "this plate"}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {plateParts.map((p) => {
                    const n = counts[p.name] ?? 0;
                    const total = Object.values(counts).reduce((t, x) => t + x, 0);
                    return (
                      <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {p.hex && <span className="dot" style={{ width: 10, height: 10, background: p.hex }} />}
                        <span style={{ flexGrow: 1, color: n ? undefined : "var(--muted)" }}>{p.label}</span>
                        <div className="step mono" role="group" aria-label={`${p.label} on the plate`}>
                          <button onClick={() => setOnPlate(p.name, n - 1)} disabled={plateBusy || n <= 0 || total <= 1} aria-label={`One fewer ${p.label}`}>−</button>
                          <b>{n}</b>
                          <button onClick={() => setOnPlate(p.name, n + 1)} disabled={plateBusy || n >= 20} aria-label={`One more ${p.label}`}>+</button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="faint" style={{ fontSize: 12 }}>
                    Each part keeps its own settings; Orca lays them out when it slices. Check the toolpaths view to see where they land.
                  </div>
                  {multi && <div style={{ fontSize: 12, color: "var(--warn)" }}>
                    {colorways.length} colours on one plate swap spools every layer, which can take several times longer than a plate per colour.
                  </div>}
                  <button className="cta cta-sm danger" style={{ alignSelf: "flex-start", height: 28 }} disabled={plateBusy}
                    onClick={() => (confirmDelete ? deletePlate() : setConfirmDelete(true))}>
                    {confirmDelete ? `Delete ${job.label ?? "plate"}?` : "Delete plate"}
                  </button>
                </div>
              </Section>
            )}

            {several && (
              <Section label="Printer">
                <PrinterSwitch printers={live.printers!} current={printer} pick={pickPrinter} live={live} />
              </Section>
            )}

            <Section label={multi ? `Filament · ${colorways.length} colours` : "Filament"}>
              {slots.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {colorways.map((c) => {
                    const pick = chosenFor(c.key);
                    return (
                      <div key={c.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {multi && <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 500 }}>{c.label.replace(/^./, (x) => x.toUpperCase())}</span>
                          <span className="muted">{pick ? `${colorName(pick.color)} · ${slotName(pick.slot)}` : ""}</span>
                        </div>}
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }} role="radiogroup" aria-label={multi ? `Filament for ${c.label}` : "Filament"}>
                          {slots.map((s) => (
                            <button key={s.slot} className="sw" role="radio" aria-checked={s.slot === picked[c.key]} style={{ background: s.color }}
                              onClick={() => setPicked((p) => ({ ...p, [c.key]: s.slot }))}
                              aria-label={`${colorName(s.color)} in ${slotName(s.slot)}${s.remain === null ? "" : `, ${s.remain}% left`}`}
                              title={`${colorName(s.color)} · ${slotName(s.slot)}${s.remain === null ? "" : ` · ${s.remain}%`}`} />
                          ))}
                          {!multi && <span className="muted" style={{ marginLeft: "auto" }}>{pick ? `${colorName(pick.color)} · ${slotName(pick.slot)}` : ""}</span>}
                        </div>
                        {!pick && (() => {
                          const near = nearestSpools(c.hex, slots);
                          return near.length > 1 && <div style={{ fontSize: 12, color: "var(--warn)" }}>
                            {near.map((s) => (s.slot === "EXT" ? "the outside spool" : s.slot)).join(" and ")} are {near.length === 2 ? "both" : "all"} {colorName(near[0].color).toLowerCase()}: pick the one to print from.
                          </div>;
                        })()}
                      </div>
                    );
                  })}
                  {multi && <div className="faint" style={{ fontSize: 12 }}>{oneColor
                    ? "All from one spool: it prints as one colour, with no colour swaps."
                    : job?.plate
                    ? "One print: the CFS swaps colour each layer, between the parts."
                    : "One print: the CFS swaps colour within each layer, so it comes off the bed as one piece."}</div>}
                  {outside && <div className="faint" style={{ fontSize: 12 }}>
                    {multi && !oneColor ? "The outside spool can only feed a one-colour print: pick it for every part." : "It prints whatever is loaded in the toolhead: load the outside spool on the printer's screen first (unloading the CFS)."}
                  </div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flexGrow: 1 }}>Material</span>
                    <div className="seg seg-sm" role="radiogroup" aria-label="Material" style={{ flex: "none" }}
                      title={perPlate > 1 ? "Wood, silk and stone are set up for one to a plate" : undefined}>
                      {(["pla", "silk", "wood", "stone"] as const).map((m) => (
                        <button key={m} role="radio" aria-checked={material === m} disabled={perPlate > 1 && m !== "pla"}
                          onClick={() => setMaterialPick(m)} style={{ padding: "0 10px" }}>{MATERIAL_NAMES[m]}</button>
                      ))}
                    </div>
                  </div>
                  {material !== "pla" && <div className="faint" style={{ fontSize: 12 }}>
                    {material === "wood"
                      ? "Wood fill: 210 °C, slower walls and longer retraction, so it strings less."
                      : material === "stone"
                        ? "Stone fill: a 60 °C bed and 225 °C for the first layer so it grips, flow capped at 12 mm³/s. Use a 0.6 mm nozzle."
                        : "Silk: flow capped at 10 mm³/s, so walls print slower and keep their sheen."}
                    {materialPick && materialPick !== spoolMaterial ? "" : ` The printer has this spool set as ${material}.`}
                  </div>}
                </div>
              ) : <div className="muted">The printer reports no spools{status?.online ? "" : " (offline)"}.</div>}
            </Section>

            <Section label="Copies">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {fit > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flexGrow: 1 }}>On one plate</span>
                    <div className="step mono" role="group" aria-label="Copies on one plate">
                      <button onClick={() => setPerPlate(Math.max(1, perPlate - 1))} disabled={perPlate <= 1} aria-label="Fewer on the plate">−</button>
                      <b>{perPlate}</b>
                      <button onClick={() => setPerPlate(Math.min(fit, perPlate + 1))} disabled={perPlate >= fit} aria-label="More on the plate">+</button>
                    </div>
                    <button className="cta cta-sm" style={{ height: 30 }} disabled={perPlate === fit} onClick={() => setPerPlate(fit)}
                      title={`As many as fit: ${fit}`}>Fill · {fit}</button>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flexGrow: 1 }}>{fit > 1 ? "Plates" : "Copies"}</span>
                  <div className="step mono" role="group" aria-label={fit > 1 ? "Plates, one after another" : "Copies, one after another"}>
                    <button onClick={() => setCopies(Math.max(1, copies - 1))} disabled={copies <= 1} aria-label="Fewer">−</button>
                    <b>{copies}</b>
                    <button onClick={() => setCopies(Math.min(20, copies + 1))} aria-label="More">+</button>
                  </div>
                </div>
                {(perPlate > 1 || copies > 1) && (
                  <div className="faint" style={{ fontSize: 12 }}>
                    {perPlate > 1 && <>{perPlate} laid out in a grid on one plate{multi ? ", all sharing each colour swap" : ""}. </>}
                    {copies > 1 && <>{copies} {fit > 1 ? "plates" : "copies"} one after another; you confirm a clear bed between them.</>}
                  </div>
                )}
              </div>
            </Section>

            <Section label="Print checks" open={open.checks} toggle={() => flip("checks")}
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {checking && <div className="agent-note"><span className="spinner" aria-hidden="true" /> Checking it as it will print…</div>}
                {!checking && !checks && <div className="muted">Checks unavailable.</div>}
                {checks && checks.findings.length === 0 && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}><span className="dot" style={{ background: "var(--ok)" }} />
                    No overhangs, thin walls, loose pieces or bed problems</div>
                )}
                {checks?.findings.map((f, i) => (
                  <button key={i} className="finding" onClick={() => setMode("layout")} title={`${f.rule}: ${f.detail} · show it`}>
                    <span className="dot" style={{ background: SEVERITY_COLORS[f.severity] }} />
                    <span>{f.message}<small>{f.rule} · {f.detail}</small></span>
                  </button>
                ))}
                {checks?.supports && <div className="faint" style={{ fontSize: 12 }}>Supports are on for this job.</div>}
                {canEdit && (
                  <button className="cta cta-md" style={{ marginTop: 6 }} disabled={session?.running} onClick={analyze}
                    title="Claude reviews it against its design rules and these checks, then fixes what it can">
                    {ICONS.spark}Analyze and correct
                  </button>
                )}
              </div>
            </Section>

            <Section label="Total" extra={slicing ? <span className="count" style={{ display: "flex", gap: 6, alignItems: "center" }}><span className="spinner" />slicing</span> : null}>
              <div className="grid3">
                <div className="tile"><div className="k">Time</div><div className="v mono">{total ?? "—"}</div></div>
                <div className="tile"><div className="k">Filament</div><div className="v mono">{stats ? `${Math.round(stats.grams * copies)} g` : "—"}</div></div>
                <div className="tile"><div className="k">Cost</div><div className="v mono">{stats ? money(stats.cost.total * copies) : "—"}</div></div>
              </div>
              {estimated && !slicing && !failed && <div className="muted" style={{ marginTop: 10 }}>Estimated from the plates sliced so far, until this one is.</div>}
              {failed && !slicing && <div style={{ marginTop: 10, color: "var(--bad)" }}>Slicing failed.{" "}
                <button className="link-btn" onClick={slice}>Try again</button>
                <div className="log">{log.slice(-5).map((l) => l.line).join("\n")}</div></div>}
              {!job && <div className="muted" style={{ marginTop: 10 }}>No job file, so it can't be sliced or printed yet.</div>}
              {job && !stats && !slicing && <div className="muted" style={{ marginTop: 10 }}>Not sliced yet. It slices when you print, or <button className="link-btn" onClick={slice}>slice now</button>.</div>}
              {slicing && log.length > 0 && <div className="log" aria-live="polite">{log.slice(-4).map((l) => l.line).join("\n")}</div>}
            </Section>
          </div>
        )}

        {tab === "design" && (
          <div className="panel-body">
            {params.length > 0 ? (
              <Section label="Parameters" open={open.params} toggle={() => flip("params")}
                icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>}>
                <Params params={params} value={value} set={(name, v) => setEdits({ ...edits, [name]: v })} />
              </Section>
            ) : null}
            <div className="sec muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {params.length
                ? <>Values in green differ from the file and are kept in <code className="mono">{job?.file}</code>. Save re-renders and re-slices it.</>
                : canEdit ? "This model has no editable parameters. Ask Claude in the Claude tab to add some."
                  : <>This is a downloaded {model.kind?.toUpperCase()} mesh, so its shape is fixed. Ask Claude to <button className="link-btn" style={{ padding: 0 }} onClick={newModel}>design an editable version</button>.</>}
            </div>
            {model.source && (
              <Section label="Notes" open={open.notes} toggle={() => flip("notes")}>
                <Source text={model.source} />
              </Section>
            )}
          </div>
        )}

        {tab === "claude" && (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column" }}>
            {!canEdit ? (
              <div className="sec muted">Claude can only edit OpenSCAD and nurb models. This one is a downloaded {model.kind?.toUpperCase()} mesh,
                so its shape is fixed; <button className="link-btn" style={{ padding: 0 }} onClick={newModel}>start a new model</button> to have Claude design a version you can change.</div>
            ) : session ? (
              <AgentPanel session={session} toast={toast} allowUploads starters={drawn ? EDIT_STARTERS : undefined} onNewChat={() => openAgent(true)}
                placeholder="Ask Claude to change this model…"
                empty={<div className="muted" style={{ fontSize: 12.5 }}>
                  Claude edits <code>models/{model.id}/</code>{job ? <> and <code>{job.file}</code></> : null}, renders to check, and the
                  stage updates as it goes. Every change can be undone. Re-slice when you're happy.
                </div>} />
            ) : <div className="sec agent-note"><span className="spinner" /> Starting…</div>}
          </div>
        )}

        {tab === "print" && (
          <div className="panel-foot">
            <button className="cta go" disabled={!job || !chosen || sending} onClick={print}>{ICONS.print}{ctaLabel}</button>
          </div>
        )}
        {tab === "design" && params.length > 0 && (
          <div className="panel-foot grid2">
            <button className="cta cta-md" disabled={atDefaults || saving || slicing}
              onClick={() => setEdits(Object.fromEntries(params.map((p) => [p.name, p.default])))}>Reset</button>
            <button className="cta cta-md go" disabled={!dirty || saving || slicing} onClick={saveAndSlice}>
              {saving ? "Saving…" : slicing ? "Slicing…" : "Save & re-slice"}
            </button>
          </div>
        )}
      </aside>, inspectorSlot)}

      {removing && (
        <div className="scrim" onClick={() => !libBusy && setRemoving(false)}>
          <div className="panel dialog" role="dialog" aria-modal="true" aria-labelledby="delete-model" onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-model">Delete {title(model.id)}?</h2>
            <div className="muted">
              Its folder and job files{model.jobs.some((j) => j.plate) ? " and plates" : ""} move to the Trash on the Mac running Print Bay, so you can
              still get them back. Its slices are removed. If the library is in git, the deletion shows in Changes until you commit it.
            </div>
            <div className="grid2">
              <button className="cta cta-md" autoFocus disabled={libBusy} onClick={() => setRemoving(false)}>Cancel</button>
              <button className="cta cta-md danger" disabled={libBusy} onClick={remove}>{libBusy ? "Deleting…" : "Delete"}</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(false)}>
          <div className="panel dialog" role="dialog" aria-modal="true" aria-labelledby="bed-clear" onClick={(e) => e.stopPropagation()}>
            <h2 id="bed-clear">Is the bed clear{several && printer ? ` on ${printer.name}` : ""}?</h2>
            <div className="muted">
              {count > 1 ? `${count} × ` : ""}{title(model.id)} in {colorsText}{perPlate > 1 ? `, ${perPlate} to a plate` : ""}{copies > 1 ? `, ${copies} plates` : ""}.
              The first copy starts as soon as it's sent{stale ? " (it slices first)" : ""}.
              {copies > 1 ? ` You'll confirm a clear bed before each later ${fit > 1 ? "plate" : "copy"}.` : ""}
            </div>
            <div className="grid2">
              <button className="cta cta-md" onClick={() => submit(false)}>Add to queue</button>
              <button className="cta cta-md go" autoFocus onClick={() => submit(true)}>Clear, start it</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type Stats = NonNullable<Model["jobs"][number]["stats"]>;

/** Time, filament and cost for n copies on a plate, from the slices nearest n (a straight line through two). */
function interpolate(n: number, known: { n: number; stats: Stats }[]): Stats {
  const sorted = [...known].sort((a, b) => Math.abs(a.n - n) - Math.abs(b.n - n) || a.n - b.n);
  const [p, q] = sorted;
  const at = (f: (s: Stats) => number) => {
    if (!q || p.n === q.n) return (f(p.stats) / p.n) * n; // one point: scale it
    return f(p.stats) + ((f(q.stats) - f(p.stats)) / (q.n - p.n)) * (n - p.n);
  };
  return { ...p.stats, seconds: Math.max(0, at((s) => s.seconds)), grams: Math.max(0, at((s) => s.grams)), cost: { ...p.stats.cost, total: Math.max(0, at((s) => s.cost.total)) } };
}

/** mm or inches for the dimensions, remembered on this device. */
function useUnits(): ["mm" | "in", (u: "mm" | "in") => void] {
  const [units, set] = useState<"mm" | "in">(() => {
    try { return localStorage.getItem("printbay.units") === "in" ? "in" : "mm"; } catch { return "mm"; }
  });
  return [units, (u) => { set(u); try { localStorage.setItem("printbay.units", u); } catch { /* not remembered */ } }];
}

/** RGB distance under which two spools count as the same colour (both black, say). */
const SAME_COLOR = 20;

/** The spools nearest `hex`: one, or several when they're the same colour (T1A and the outside spool both black). */
function nearestSpools<S extends { slot: string; color: string }>(hex: string | null, slots: S[]): S[] {
  if (!slots.length) return [];
  if (!hex) return [slots[0]];
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const target = rgb(hex);
  const d = (s: { color: string }) => Math.hypot(...rgb(s.color).map((c, i) => c - target[i]));
  const best = Math.min(...slots.map(d));
  return slots.filter((s) => d(s) - best < SAME_COLOR);
}

/** The spool to start on: the nearest, unless two match equally (then you pick, rather than a guess feeding the wrong one). */
function nearest(hex: string | null, slots: { slot: string; color: string }[]): string | null {
  const near = nearestSpools(hex, slots);
  return near.length === 1 ? near[0].slot : null;
}

/**
 * A multi-part model's picker: its labelled jobs grouped by the words before the number
 * ("Plant 1".."Plant 6" -> Plant: 1..6; "Funnel" on its own). Null for a one-job model.
 */
/**
 * The picker for a model with several parts or plates. Numbered labels (Ring 1, Ring 2) share a
 * row under their name; the rest (Names 1-4: Archer, Amor…) are listed one to a line, and
 * neighbours share one list. Parts first, then the plates that hold them.
 */
function pickerGroups(jobs: Model["jobs"]): { name: string | null; jobs: { job: Model["jobs"][number]; short: string }[] }[] | null {
  const labelled = jobs.filter((j) => j.label);
  if (labelled.length < 2) return null;
  const groups = new Map<string, { job: Model["jobs"][number]; short: string }[]>();
  for (const job of labelled) {
    const m = job.label!.match(/^(.*?)\s*(\d+)$/);
    const [name, short] = m ? [m[1], m[2]] : [job.label!, job.label!];
    groups.set(name, [...(groups.get(name) ?? []), { job, short }]);
  }
  const sorted = [...groups].map(([name, js]) => ({ name: js.length === 1 && js[0].short === name ? null : name, jobs: js }))
    .sort((a, b) => Number(!!a.jobs[0].job.plate) - Number(!!b.jobs[0].job.plate));
  return sorted.reduce<typeof sorted>((out, g) => {
    const last = out[out.length - 1];
    if (g.name === null && last?.name === null && !!last.jobs[0].job.plate === !!g.jobs[0].job.plate) last.jobs.push(...g.jobs);
    else out.push(g);
    return out;
  }, []);
}
