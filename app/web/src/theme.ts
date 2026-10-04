import { useEffect, useState } from "react";

// Light or dark: follows macOS until the toolbar switch picks one, which is remembered.
export type Theme = "light" | "dark";

const KEY = "printbay.theme";
const media = () => matchMedia("(prefers-color-scheme: light)");

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch { return null; }
}

export function useTheme(): [Theme, () => void] {
  const [system, setSystem] = useState<Theme>(() => (media().matches ? "light" : "dark"));
  const [chosen, setChosen] = useState<Theme | null>(saved);
  useEffect(() => {
    const m = media();
    const on = () => setSystem(m.matches ? "light" : "dark");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const theme = chosen ?? system;
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setChosen(next);
    try { localStorage.setItem(KEY, next); } catch { /* private mode: not remembered */ }
  };
  return [theme, toggle];
}

/** Colors the 3D stage needs, which can't read CSS variables. */
export const STAGE_COLORS = {
  dark: { background: "#1d1f21", grid: "#2b2e31", edge: "#43474c" },
  light: { background: "#f4f4f5", grid: "#e2e2e5", edge: "#c4c4ca" },
} as const;
