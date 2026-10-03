import { money, title } from "../api";
import { Thumb } from "../components/Thumb";
import type { Model } from "../types";

interface Props {
  models: Model[];
  openModel: (id: string) => void;
  print: (model: Model) => void;
  newModel: () => void;
}

export function Library({ models, openModel, print, newModel }: Props) {
  return (
    <main className="page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 22 }}>Library</h1>
        <span className="muted">{models.length} {models.length === 1 ? "model" : "models"}</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={newModel}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
          New model</button>
      </div>
      <div className="grid">
        {models.map((m) => {
          const job = m.jobs[0];
          return (
            <div key={m.id} className="card model-card">
              <button className="thumb" onClick={() => openModel(m.id)} aria-label={`Open ${title(m.id)}`}>
                <Thumb model={m} />
              </button>
              <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <h2 style={{ fontSize: 16 }}>{title(m.id)}</h2>
                  {m.kind && <span className="badge">{m.kind}</span>}
                  {job?.stale && <span className="badge badge-warn">{job.stats ? "changed" : "not sliced"}</span>}
                </div>
                <div className="mono" style={{ fontSize: 13 }}>
                  {job?.stats
                    ? `${job.stats.time.replace(/ \d+s$/, "")} · ${Math.round(job.stats.grams)} g · ${money(job.stats.cost.total)}`
                    : <span className="muted">{job ? "Not sliced yet" : "No job file"}</span>}
                </div>
              </div>
              <div className="card-pad" style={{ display: "flex", gap: 10, paddingTop: 12 }}>
                <button className="btn btn-primary" disabled={!job} onClick={() => print(m)}>Print</button>
                <button className="btn" onClick={() => openModel(m.id)}>Edit</button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
