import { useEffect, useState } from "react";
import { api, colorName, duration, jobFromFilename, title, type Live } from "../api";
import { SegRow } from "../components/SegRow";
import { Thumb } from "../components/Thumb";
import { IDLE_STATES, type Model, type Printer } from "../types";

const LABELS: Record<string, [string, string]> = {
  printing: ["Printing", "var(--ok)"],
  paused: ["Paused", "var(--warn)"],
  complete: ["Finished", "var(--ok)"],
  cancelled: ["Cancelled", "var(--muted)"],
  standby: ["Idle", "var(--muted)"],
  error: ["Error", "var(--bad)"],
  offline: ["Offline", "var(--bad)"],
};
const colorsOf = (e: { hex: string; hexes?: string[] }) => (e.hexes ?? [e.hex]).map(colorName).join(" + ");

export const stateLabel = (state: string) => LABELS[state] ?? [state, "var(--muted)"];

/** The camera's caption: which printer (when there are several), what's printing and how far along. */
export function printerCaption(printers: Printer[] | null, printer: Printer | null): string {
  if (!printers) return "Connecting to the printer…";
  if (!printer) return "No printer set up";
  const s = printer.status;
  const who = printers.length > 1 ? `${printer.name} · ` : "";
  if (!s.online) return `${who}Can't reach ${printers.length > 1 ? "it" : printer.name}`;
  const [label] = stateLabel(s.state);
  if (!s.filename || IDLE_STATES.has(s.state)) return `${printer.name} · ${label}`;
  const layer = s.layer.current != null ? ` · layer ${s.layer.current} of ${s.layer.total ?? "?"}` : "";
  return `${who}${label} ${title(jobFromFilename(s.filename))}${layer}`;
}

/** What a printer is up to, in a few words: for lists of printers. */
export function printerSummary(p: Printer, queued: number): string {
  const s = p.status;
  if (!s.online) return "can't reach it";
  if (s.state === "printing" || s.state === "paused")
    return `${s.state === "paused" ? "paused · " : ""}${Math.round(s.progress * 100)}% · ${duration(s.etaSeconds)} left`;
  return queued ? `${queued} queued` : stateLabel(s.state)[0].toLowerCase();
}

/** Every printer, to switch between: shown when there's more than one. */
export function PrinterSwitch({ printers, current, pick, live }: { printers: Printer[]; current: Printer | null; pick: (id: string) => void; live: Live }) {
  return (
    <div role="radiogroup" aria-label="Printer" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {printers.map((p) => (
        <button key={p.id} className="row" role="radio" aria-checked={p.id === current?.id} onClick={() => pick(p.id)}>
          <span className="dot" style={{ background: stateLabel(p.status.state)[1] }} />
          <span className="row-text">
            <span className="row-title">{p.name}</span>
            <span className="row-sub">{printerSummary(p, live.queue.entries.filter((e) => e.printer === p.id).length)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

interface Props {
  live: Live;
  printer: Printer | null;
  pickPrinter: (id: string) => void;
  models: Model[];
  toast: (msg: string, error?: boolean) => void;
  openModel: (id: string) => void;
}

export function PrinterPanel({ live, printer, pickPrinter, models, toast, openModel }: Props) {
  const status = printer?.status ?? null;
  const id = printer?.id ?? "";
  const queue = { active: live.queue.active[id] ?? null, entries: live.queue.entries.filter((e) => e.printer === id) };
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };

  const state = status?.state ?? "offline";
  const [label, color] = stateLabel(state);
  const modelFor = (job: string) => models.find((m) => m.jobs.some((j) => j.name === job));
  const jobName = status?.filename ? jobFromFilename(status.filename) : null;
  const model = jobName ? modelFor(jobName) : undefined;
  const active = queue.active && status && queue.active.filename === status.filename ? queue.active : null;
  const pct = Math.round((status?.progress ?? 0) * 100);
  const running = state === "printing" || state === "paused";
  const idle = IDLE_STATES.has(state);
  const next = queue.entries[0];

  if (live.printers && !printer) return <div className="sec muted">No printer set up yet. Add one in Settings.</div>;
  const several = (live.printers?.length ?? 0) > 1;

  return (
    <>
      {several && (
        <div className="sec">
          <div className="sech">Printers<span className="count">{live.printers!.length}</span></div>
          <div className="sec-body"><PrinterSwitch printers={live.printers!} current={printer} pick={pickPrinter} live={live} /></div>
        </div>
      )}
      <div className="sec">
        <div className="sech">{several && <span>{printer?.name} ·</span>}<span className="dot" style={{ background: color }} /> {label}
          {running && <span className="count">{duration(status?.etaSeconds ?? null)} left</span>}</div>
        {status?.filename ? (
          <>
            <button className="row" style={{ marginTop: 10, padding: 4 }} disabled={!model} onClick={() => model && openModel(model.id)}
              title={model ? "Open the model" : status.filename}>
              <span className="thumb thumb-lg">{model ? <Thumb model={model} /> : null}</span>
              <span className="row-text">
                <span className="row-title">{model ? title(model.id) : status.filename}</span>
                <span className="row-sub" style={{ color: "var(--muted)" }}>
                  {status.layer.current != null ? `Layer ${status.layer.current} / ${status.layer.total ?? "?"}` : label}
                  {active?.perPlate ? ` · ${active.perPlate} on the plate` : ""}{active && active.of > 1 ? ` · ${active.copy} of ${active.of}` : ""}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 20 }}>{pct}%</span>
            </button>
            <div className="progress" style={{ marginTop: 10 }} aria-label="Progress"><div style={{ width: `${pct}%` }} /></div>
            {active && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>{colorsOf(active)} from {active.slot}</div>}
          </>
        ) : (
          <div className="muted" style={{ marginTop: 10 }}>{status?.online === false ? `Can't reach ${printer?.name ?? "the printer"}. ${status.message}` : "Nothing printing."}</div>
        )}
        {running && (
          <div className="grid2" style={{ marginTop: 12 }}>
            {state === "paused"
              ? <button className="cta cta-md" disabled={busy} onClick={() => act(() => api(`/api/printers/${id}/resume`, { method: "POST" }), "Resuming.")}>Resume</button>
              : <button className="cta cta-md" disabled={busy} onClick={() => act(() => api(`/api/printers/${id}/pause`, { method: "POST" }), "Pausing.")}>Pause</button>}
            <button className="cta cta-md danger" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel</button>
          </div>
        )}
      </div>

      <div className="sec">
        <div className="grid2">
          {([["Nozzle", status?.nozzle], ["Bed", status?.bed]] as const).map(([name, t]) => (
            <div key={name} className="tile">
              <div className="k">{name}</div>
              <div className="v mono">{t ? Math.round(t.temp) : "—"}<span className="faint" style={{ fontSize: 12 }}> / {t ? Math.round(t.target) : "—"}°C</span></div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <SegRow label="Nozzle size" disabled={busy} value={printer?.nozzle ?? null} options={["0.4", "0.6"].map((n) => ({ value: n, label: `${n} mm` }))}
            onPick={(n) => act(() => api(`/api/printers/${id}/nozzle`, { method: "PUT", json: { nozzle: n } }),
              `Slicing for ${several ? `${printer?.name}'s` : "the"} ${n} mm nozzle from now on.`)} />
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Set this when you swap {several ? "this printer's" : "the"} nozzle: its prints are sliced for it.</div>
      </div>

      <div className="sec">
        <div className="sech">Filament</div>
        <div className="sec-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {status?.slots.length ? status.slots.map((s) => (
            <div key={s.slot} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="dot" style={{ width: 14, height: 14, background: s.color, boxShadow: "0 0 0 1px var(--line) inset" }} />
              <span style={{ flexGrow: 1 }}>{colorName(s.color)}</span>
              <span className="mono faint">{s.slot === "EXT" ? "Outside" : s.slot}</span>
              <span className="mono muted" style={{ width: 40, textAlign: "right" }}>{s.remain === null ? "—" : `${s.remain}%`}</span>
            </div>
          )) : <div className="muted">No spools reported.</div>}
        </div>
      </div>

      <div className="sec">
        <div className="sech">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" /></svg>
          Queue<span className="count">{queue.entries.length}</span>
        </div>
        {queue.entries.length === 0 ? (
          <div className="muted sec-body">Empty. Print a model from the Models tab.</div>
        ) : (
          <div className="sec-body" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {queue.entries.map((e, i) => {
              const m = modelFor(e.job);
              return (
                <div key={e.id} className="row" style={{ cursor: "default" }}>
                  <span className="thumb thumb-sm">{m ? <Thumb model={m} /> : null}</span>
                  <span className="row-text">
                    <span>{title(e.job)}{e.perPlate ? ` × ${e.perPlate}` : ""} <span className="faint">· {e.copy} of {e.of}</span></span>
                    <span className="row-sub">{(e.hexes ?? [e.hex]).map((h, k) => <span key={k} className="dot" style={{ width: 7, height: 7, background: h, marginRight: 5 }} />)}{colorsOf(e)} · {e.slot}{i === 0 && !idle ? " · after this print" : ""}</span>
                  </span>
                  <button className="ibtn" aria-label={`Remove ${title(e.job)} copy ${e.copy}`} title="Remove"
                    onClick={() => act(() => api(`/api/queue/${e.id}`, { method: "DELETE" }))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </div>
              );
            })}
            <button className="cta cta-md go" style={{ marginTop: 8 }} disabled={!idle || busy || !next}
              title={idle ? "" : "Waiting for the current print to finish"}
              onClick={() => act(() => api(`/api/printers/${id}/queue/next`, { method: "POST" }), `Starting ${title(next.job)}.`)}>
              {idle ? "Bed is clear, start next" : "Starts after this print"}
            </button>
          </div>
        )}
      </div>

      {confirmCancel && (
        <div className="scrim" onClick={() => setConfirmCancel(false)}>
          <div className="panel dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-print" onClick={(e) => e.stopPropagation()}>
            <h2 id="cancel-print">Cancel this print?</h2>
            <div className="muted">The printer stops and the part is lost. This can't be undone.</div>
            <div className="grid2">
              <button className="cta cta-md" autoFocus onClick={() => setConfirmCancel(false)}>Keep printing</button>
              <button className="cta cta-md danger" disabled={busy} onClick={async () => {
                setConfirmCancel(false);
                await act(() => api(`/api/printers/${id}/cancel`, { method: "POST" }), "Print cancelled. Clear the bed before the next one.");
              }}>Cancel print</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
