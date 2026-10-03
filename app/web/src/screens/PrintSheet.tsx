import { useEffect, useMemo, useState } from "react";
import { api, colorName, duration, money, title } from "../api";
import { IDLE_STATES, type Model, type PrinterStatus } from "../types";

interface Props {
  model: Model;
  status: PrinterStatus | null;
  close: () => void;
  toast: (msg: string, error?: boolean) => void;
}

function nearest(hex: string | null, slots: PrinterStatus["slots"]) {
  if (!hex || !slots.length) return slots[0]?.slot ?? null;
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const target = rgb(hex);
  return slots.reduce((best, s) => {
    const d = (x: typeof s) => Math.hypot(...rgb(x.color).map((c, i) => c - target[i]));
    return d(s) < d(best) ? s : best;
  }).slot;
}

export function PrintSheet({ model, status, close, toast }: Props) {
  const job = model.jobs[0];
  const slots = status?.slots ?? [];
  const [slot, setSlot] = useState<string | null>(() => nearest(job.hex, slots));
  const [copies, setCopies] = useState(job.copies);
  const [bedClear, setBedClear] = useState(false);
  const [working, setWorking] = useState(false);
  const idle = status ? IDLE_STATES.has(status.state) : false;
  useEffect(() => { // status may arrive after the sheet opens
    if (!slot && slots.length) setSlot(nearest(job.hex, slots));
  }, [slot, slots, job.hex]);
  const chosen = slots.find((s) => s.slot === slot);

  const estimate = useMemo(() => {
    if (!job.stats) return null;
    const s = job.stats;
    return `${duration(s.seconds * copies)} · ${Math.round(s.grams * copies)} g · ${money(s.cost.total * copies)}`;
  }, [job.stats, copies]);

  const submit = async () => {
    if (!chosen) return;
    setWorking(true);
    try {
      const startNow = idle && bedClear;
      const r = await api<{ started: boolean; queued: number; slot: string }>("/api/print", {
        method: "POST", json: { job: job.name, color: chosen.color, copies, startNow },
      });
      const what = `${title(model.id)} in ${colorName(chosen.color).toLowerCase()}`;
      toast(r.started
        ? `Started ${what}.${r.queued ? ` ${r.queued} more ${r.queued === 1 ? "copy" : "copies"} queued.` : ""}`
        : `Queued ${r.queued} × ${what}.`);
      close();
    } catch (e) {
      toast((e as Error).message, true);
      setWorking(false);
    }
  };

  return (
    <div className="scrim" onClick={() => !working && close()}>
      <div className="card dialog" role="dialog" aria-label="Start print" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="label">Print</div>
          <h2 style={{ fontSize: 20, marginTop: 4 }}>{title(model.id)}</h2>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="muted">Filament</div>
          {slots.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {slots.map((s) => (
                <button key={s.slot} className="chip" aria-pressed={s.slot === slot} onClick={() => setSlot(s.slot)}>
                  <span className="swatch" style={{ background: s.color }} />{colorName(s.color)}
                  <span className="faint mono">{s.remain}%</span>
                </button>
              ))}
            </div>
          ) : <div className="muted">The printer reports no spools{status?.online ? "" : " (offline)"}.</div>}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="muted">Copies</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="chip" aria-label="Fewer copies" onClick={() => setCopies(Math.max(1, copies - 1))}>−</button>
            <span className="mono" style={{ fontSize: 18, width: 28, textAlign: "center" }}>{copies}</span>
            <button className="chip" aria-label="More copies" onClick={() => setCopies(Math.min(20, copies + 1))}>+</button>
          </div>
        </div>

        <div className="log" style={{ color: "var(--ink)" }}>
          {estimate ?? "Not sliced yet."}
          {job.stale && <div className="muted" style={{ marginTop: 4 }}>{job.stats ? "Changed since the last slice: it re-slices first." : "It slices first (about a minute)."}</div>}
        </div>

        {idle ? (
          <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={bedClear} onChange={(e) => setBedClear(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--accent)" }} />
            The bed is clear — start the first copy now
          </label>
        ) : (
          <div className="muted">The printer is {status?.state ?? "offline"}, so this goes in the queue.</div>
        )}
        {copies > 1 && <div className="faint" style={{ fontSize: 13 }}>You'll confirm a clear bed before each later copy.</div>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" disabled={working} onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={!chosen || working} onClick={submit}>
            {working ? (job.stale ? "Slicing & uploading…" : "Uploading…") : idle && bedClear ? "Start print" : "Add to queue"}
          </button>
        </div>
      </div>
    </div>
  );
}
