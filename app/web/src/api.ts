import { useEffect, useState } from "react";
import type { AgentSession, Model, Printer, QueueState, Repo, SettingsView, SliceEvent, UpdateStatus } from "./types";

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json === undefined ? rest.headers : { "Content-Type": "application/json", ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Live {
  printers: Printer[] | null; // null until the server first says
  queue: QueueState;
  slice: Record<string, SliceEvent[]>; // log lines per job
  modelsVersion: number; // bumps when models/slices change
  agents: Record<string, AgentSession>; // Claude sessions updated since load
  update: UpdateStatus | null; // the desktop app's updater; null in a browser
}

/** One EventSource for the whole app: printers and their status, queue, slicing progress, app updates. */
export function useLive(): Live {
  const [live, setLive] = useState<Live>({ printers: null, queue: { active: {}, entries: [] }, slice: {}, modelsVersion: 0, agents: {}, update: null });
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("printers", (e) => setLive((l) => ({ ...l, printers: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener("queue", (e) => setLive((l) => ({ ...l, queue: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener("agent", (e) => {
      const s: AgentSession = JSON.parse((e as MessageEvent).data);
      setLive((l) => ({ ...l, agents: { ...l.agents, [s.id]: s } }));
    });
    es.addEventListener("update", (e) => setLive((l) => ({ ...l, update: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener("models", () => setLive((l) => ({ ...l, modelsVersion: l.modelsVersion + 1 })));
    es.addEventListener("slice", (e) => {
      const ev: SliceEvent = JSON.parse((e as MessageEvent).data);
      setLive((l) => {
        // a new slice (of a job or a plate) starts a fresh log; "Still slicing…" replaces the last one
        const started = /^Slicing (jobs|plates)\//.test(ev.line);
        let prev = started ? [] : l.slice[ev.job] ?? [];
        if (ev.line.startsWith("Still slicing") && prev[prev.length - 1]?.line.startsWith("Still slicing")) prev = prev.slice(0, -1);
        return { ...l, slice: { ...l.slice, [ev.job]: [...prev, ev].slice(-200) } };
      });
    });
    return () => es.close();
  }, []);
  return live;
}

/** Every model, with its slices for the nozzle on `printer` (the one in view). */
export function useModels(version: number, printer: string | null): Model[] | null {
  const [models, setModels] = useState<Model[] | null>(null);
  useEffect(() => {
    api<Model[]>(`/api/models${printer ? `?printer=${encodeURIComponent(printer)}` : ""}`).then(setModels).catch(() => setModels([]));
  }, [version, printer]);
  return models;
}

/** The library's git repo: refetched when files change, the window regains focus, or `set` is called after an action. */
export function useRepos(version: number): [Repo[] | null, (r: Repo[]) => void] {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  useEffect(() => {
    const load = () => api<Repo[]>("/api/repos").then(setRepos).catch(() => setRepos([]));
    load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, [version]);
  return [repos, setRepos];
}

/** Setup and settings, refetched when the window regains focus (a tool may have been installed meanwhile). */
export function useSettings(): [SettingsView | null, (s: SettingsView) => void] {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  useEffect(() => {
    const load = () => api<SettingsView>("/api/settings").then(setSettings).catch(() => {});
    load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, []);
  return [settings, setSettings];
}

// ---- formatting ----

/** How a model's source shows in lists: SCAD, NURB (a nurb part, .py), 3MF, STL. */
export const kindLabel = (kind: string | null) => (kind === "py" ? "NURB" : kind?.toUpperCase() ?? null);

export const money = (n: number) => `$${n.toFixed(2)}`;
export const mm = (n: number) => `${n.toFixed(1)} mm`;
export const inches = (n: number) => `${(n / 25.4).toFixed(2)}″`;

export function duration(secs: number | null): string {
  if (secs === null || !isFinite(secs)) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function title(id: string): string {
  return id.split(/[-_]/).map((w) => (/^v\d+$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
}

const NAMED: Record<string, string> = {
  Black: "#000000", White: "#FFFFFF", Grey: "#808080", Red: "#C12E1F", Orange: "#FF6A13", Yellow: "#F4D53F",
  Green: "#00AE42", Blue: "#0A2989", Purple: "#5E43B7", Pink: "#E4BDD0", Brown: "#7C4B00",
};

/** A friendly name for a spool color: the nearest of the named colors. */
export function colorName(hex: string): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex);
  let best = "Color", bestD = Infinity;
  for (const [name, h] of Object.entries(NAMED)) {
    const [r2, g2, b2] = rgb(h);
    const d = Math.hypot(r - r2, g - g2, b - b2);
    if (d < bestD) { best = name; bestD = d; }
  }
  return best;
}

/** The job behind a printer filename: "stacking-box-T1A.gcode" -> "stacking-box". */
export function jobFromFilename(filename: string): string {
  return filename.replace(/\.gcode$/, "").replace(/-T\d[A-D]$/, "");
}

/** The printer in view (Printer tab, Print box): the one picked last, else the first. Remembered on this browser. */
export function useCurrentPrinter(printers: Printer[] | null): [Printer | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(() => localStorage.getItem("printbay.printer"));
  const pick = (next: string) => { setId(next); localStorage.setItem("printbay.printer", next); };
  return [printers?.find((p) => p.id === id) ?? printers?.[0] ?? null, pick];
}

/** A Claude session: fetched once, then kept current by live `agent` events. */
export function useAgentSession(id: string | null, live: Live): AgentSession | null {
  const [fetched, setFetched] = useState<AgentSession | null>(null);
  useEffect(() => {
    setFetched(null);
    if (id) api<AgentSession>(`/api/agent/${id}`).then(setFetched).catch(() => setFetched(null));
  }, [id]);
  if (!id) return null;
  return live.agents[id] ?? (fetched?.id === id ? fetched : null);
}
