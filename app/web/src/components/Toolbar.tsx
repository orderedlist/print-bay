import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Theme } from "../theme";
import type { ViewAvailability, ViewMode } from "./ModelViewer";

export interface Action { label: string; icon: ReactNode; run: () => void; disabled?: boolean; accent?: boolean }

const VIEWS: { mode: ViewMode; label: string; icon: ReactNode; off: string }[] = [
  { mode: "model", label: "Model", off: "", icon: <path d="M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8" /> },
  { mode: "paths", label: "Toolpaths", off: "Slice it to see its toolpaths", icon: <path d="M4 7h16M4 12h16M4 17h16" /> },
  { mode: "stress", label: "Stress", off: "Waiting for the model", icon: <path d="M3 12h4l3-8 4 16 3-8h4" /> },
  { mode: "layout", label: "Layout · as it prints, with check findings", off: "Preparing the print layout", icon: <><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M8 14V8h8v6" /></> },
];

interface Props {
  actions: Action[];
  mode: ViewMode | null; // null: no model, views off
  available?: ViewAvailability;
  setMode?: (mode: ViewMode) => void;
  theme: Theme;
  toggleTheme: () => void;
}

/** The floating bar at the bottom of the stage: actions, views, light/dark. */
export function Toolbar({ actions, mode, available, setMode, theme, toggleTheme }: Props) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(".menu-row:not([aria-disabled=true])")?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && (e.target as Element).closest?.(".menu, .tool.add")) return;
      setOpen(false);
    };
    addEventListener("keydown", close);
    addEventListener("pointerdown", close);
    return () => { removeEventListener("keydown", close); removeEventListener("pointerdown", close); };
  }, [open]);

  return (
    <>
      {open && (
        <div ref={menu} className="panel menu centered" role="menu" aria-label="Actions" style={{ marginLeft: -60 }}>
          <div className="menu-title">Actions</div>
          {actions.map((a) => (
            <button key={a.label} className="menu-row" role="menuitem" aria-disabled={a.disabled || undefined}
              onClick={() => { if (a.disabled) return; setOpen(false); a.run(); }}>
              <span className="ico" style={{ color: a.accent ? "var(--acc)" : "var(--ink)" }}>{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="panel toolbar centered" role="toolbar" aria-label="View">
        <button className="tool add" aria-label="Actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <span className="tool-sep" />
        {VIEWS.map((v) => {
          const can = mode !== null && !!available?.[v.mode];
          return (
            <button key={v.mode} className="tool" aria-pressed={mode === v.mode} disabled={!can} aria-label={v.label.split(" ·")[0]}
              title={can || mode === null ? v.label : v.off} onClick={() => setMode?.(v.mode)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{v.icon}</svg>
            </button>
          );
        })}
        <span className="tool-sep" />
        <button className="tool" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"} title="Light or dark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" /></svg>
        </button>
      </div>
    </>
  );
}

const icon = (d: ReactNode) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const ICONS = {
  print: icon(<><path d="M6 9V3h12v6M6 18H4V9h16v9h-2" /><rect x="6" y="14" width="12" height="7" /></>),
  slice: icon(<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />),
  spark: icon(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />),
  plus: icon(<path d="M12 5v14M5 12h14" />),
};
