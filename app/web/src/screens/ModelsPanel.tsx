import { forwardRef, useState } from "react";
import { kindLabel, title } from "../api";
import { Thumb } from "../components/Thumb";
import { ICONS } from "../components/Toolbar";
import type { Model } from "../types";

interface Props {
  models: Model[];
  selected: string | null;
  open: (id: string) => void;
  create: (() => void) | null; // null: Claude Code isn't set up
}

/** The library: create with Claude, search, and every model. */
export const ModelsPanel = forwardRef<HTMLInputElement, Props>(function ModelsPanel({ models, selected, open, create }, search) {
  const [query, setQuery] = useState("");
  const [libOpen, setLibOpen] = useState(true);
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => `${title(m.id)} ${m.id} ${m.kind ?? ""}`.toLowerCase().includes(q)) : models;

  return (
    <>
      {create && (
        <div className="sec">
          <button className="cta go cta-md" onClick={create}>{ICONS.spark}Create with Claude</button>
        </div>
      )}
      <div className="sec">
        <label className="search" style={{ marginBottom: 14 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className="sr-only">Search models</span>
          <input ref={search} type="search" value={query} placeholder="Search…" onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); if (e.key === "Enter" && shown[0]) open(shown[0].id); }} />
          {!query && <span className="kbd" aria-hidden="true">⌘F</span>}
        </label>
        <button className="sech" aria-expanded={libOpen} onClick={() => setLibOpen(!libOpen)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
          Library<span className="count">{shown.length}</span>
          <svg className="chev" style={{ marginLeft: 8 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {libOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
            {shown.map((m) => {
              const job = m.jobs[0];
              const [dot, why] = !m.file ? ["var(--acc)", "being designed"]
                : !job ? ["var(--faint)", "no job file"]
                : job.slicing ? ["var(--acc)", "slicing"]
                  : !job.stats ? ["var(--faint)", "not sliced"]
                    : job.stale ? ["var(--warn)", "changed since slice"] : ["var(--ok)", "sliced"];
              return (
                <button key={m.id} className="row" aria-current={m.id === selected} onClick={() => open(m.id)}>
                  <span className="thumb"><Thumb model={m} /></span>
                  <span className="row-text">
                    <span className="row-title">{title(m.id)}</span>
                    <span className="row-sub">{kindLabel(m.kind) ?? "NEW"} · {job?.stats ? job.stats.time.replace(/ \d+s$/, "") : why}</span>
                  </span>
                  <span className="dot" style={{ background: dot }} title={why} />
                </button>
              );
            })}
            {shown.length === 0 && <div className="muted" style={{ padding: 8 }}>{q ? `Nothing matches “${query}”.` : "No models yet."}</div>}
          </div>
        )}
      </div>
    </>
  );
});
