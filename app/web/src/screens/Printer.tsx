import { useState } from "react";
import { api, colorName, duration, jobFromFilename, title, type Live } from "../api";
import { Camera } from "../components/Camera";
import { IDLE_STATES, type Model } from "../types";

const LABELS: Record<string, [string, string]> = {
  printing: ["Printing", "var(--ok)"],
  paused: ["Paused", "var(--warn)"],
  complete: ["Finished", "var(--ok)"],
  cancelled: ["Cancelled", "var(--muted)"],
  standby: ["Idle", "var(--muted)"],
  error: ["Error", "var(--danger)"],
  offline: ["Offline", "var(--danger)"],
};
export const stateLabel = (state: string) => LABELS[state] ?? [state, "var(--muted)"];

interface Props {
  live: Live;
  models: Model[];
  toast: (msg: string, error?: boolean) => void;
  openModel: (id: string) => void;
}

export function Printer({ live, models, toast, openModel }: Props) {
  const { status, queue } = live;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };

  const state = status?.state ?? "offline";
  const [label, color] = stateLabel(state);
  const jobName = status?.filename ? jobFromFilename(status.filename) : null;
  const model = jobName ? models.find((m) => m.jobs.some((j) => j.name === jobName)) : undefined;
  const active = queue.active && status && queue.active.filename === status.filename ? queue.active : null;
  const pct = Math.round((status?.progress ?? 0) * 100);
  const running = state === "printing" || state === "paused";
  const idle = IDLE_STATES.has(state);
  const next = queue.entries[0];

  return (
    <main className="page split">
      <section className="wide">
        <div className="card">
          <Camera>
            <div className="overlay">
              <span className="tag" style={{ color }}>● {label}</span>
              {status?.layer.current != null && (
                <span className="tag mono">Layer {status.layer.current} / {status.layer.total ?? "?"}</span>
              )}
            </div>
          </Camera>
          <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {status?.filename ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 16px" }}>
                  <button className="tab" style={{ padding: 0, height: "auto", fontSize: 20, fontWeight: 600, color: "var(--ink)" }}
                    onClick={() => model && openModel(model.id)} disabled={!model}>
                    {model ? title(model.id) : status.filename}
                  </button>
                  <span className="muted">
                    {active ? `copy ${active.copy} of ${active.of} · ${colorName(active.hex).toLowerCase()} from ${active.slot}` : status.filename}
                  </span>
                  <span className="spacer" />
                  <span className="mono muted">{pct}% · {running ? `${duration(status.etaSeconds)} left` : label.toLowerCase()}</span>
                </div>
                <div className="progress" aria-label="Progress"><div style={{ width: `${pct}%` }} /></div>
              </>
            ) : (
              <div className="muted">{status?.online === false ? `Can't reach the printer. ${status.message}` : "Nothing printing."}</div>
            )}
            {running && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {state === "paused"
                  ? <button className="btn" disabled={busy} onClick={() => act(() => api("/api/printer/resume", { method: "POST" }), "Resuming.")}>Resume</button>
                  : <button className="btn" disabled={busy} onClick={() => act(() => api("/api/printer/pause", { method: "POST" }), "Pausing.")}>Pause</button>}
                <button className="btn btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel print</button>
              </div>
            )}
          </div>
        </div>
      </section>

      <aside className="side">
        <div className="card card-pad" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
          {([["Nozzle", status?.nozzle], ["Bed", status?.bed]] as const).map(([name, t]) => (
            <div key={name}>
              <div className="label">{name}</div>
              <div className="mono" style={{ fontSize: 26, marginTop: 4 }}>
                {t ? Math.round(t.temp) : "—"}<span className="faint" style={{ fontSize: 16 }}> / {t ? Math.round(t.target) : "—"}°C</span>
              </div>
            </div>
          ))}
        </div>

        <div className="card card-pad">
          <div className="card-head"><h2 style={{ fontSize: 15 }}>Filament</h2><span className="muted" style={{ fontSize: 12 }}>CFS</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {status?.slots.length ? status.slots.map((s) => (
              <div key={s.slot} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="swatch" style={{ background: s.color, width: 22, height: 22 }} />
                <span className="mono muted" style={{ width: 34 }}>{s.slot}</span>
                <span style={{ flexGrow: 1 }}>{colorName(s.color)}</span>
                <span className="mono muted">{s.remain}%</span>
              </div>
            )) : <div className="muted">No spools reported.</div>}
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-head"><h2 style={{ fontSize: 15 }}>Queue</h2><span className="muted" style={{ fontSize: 12 }}>{queue.entries.length} waiting</span></div>
          {queue.entries.length === 0 ? (
            <div className="muted">Empty. Start a print from the Library.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {queue.entries.map((e) => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="swatch" style={{ background: e.hex }} />
                  <span style={{ flexGrow: 1, minWidth: 0 }}>
                    {title(e.job)} <span className="muted">· copy {e.copy} of {e.of}</span>
                  </span>
                  <button className="btn btn-sm btn-icon" aria-label={`Remove ${e.job} copy ${e.copy}`}
                    onClick={() => act(() => api(`/api/queue/${e.id}`, { method: "DELETE" }))}>✕</button>
                </div>
              ))}
              <button className="btn btn-primary" disabled={!idle || busy || !next}
                title={idle ? "" : "Waiting for the current print to finish"}
                onClick={() => act(() => api("/api/queue/next", { method: "POST" }), `Starting ${title(next.job)}.`)}>
                {idle ? "Bed is clear — start next" : "Starts after this print"}
              </button>
            </div>
          )}
        </div>
      </aside>

      {confirmCancel && (
        <div className="scrim" onClick={() => setConfirmCancel(false)}>
          <div className="card dialog" role="dialog" aria-label="Cancel print" onClick={(e) => e.stopPropagation()}>
            <h2>Cancel this print?</h2>
            <div className="muted">The printer stops and the part is lost. This can't be undone.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setConfirmCancel(false)}>Keep printing</button>
              <button className="btn btn-danger" disabled={busy} onClick={async () => {
                setConfirmCancel(false);
                await act(() => api("/api/printer/cancel", { method: "POST" }), "Print cancelled. Clear the bed before the next one.");
              }}>Cancel print</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
