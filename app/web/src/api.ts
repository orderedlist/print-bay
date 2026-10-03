import { useEffect, useState } from "react";
import type { Model, PrinterStatus, QueueState, SliceEvent } from "./types";

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
  status: PrinterStatus | null;
  queue: QueueState;
  slice: Record<string, SliceEvent[]>; // log lines per job
  modelsVersion: number; // bumps when models/slices change
}

/** One EventSource for the whole app: printer status, queue, slicing progress. */
export function useLive(): Live {
  const [live, setLive] = useState<Live>({ status: null, queue: { active: null, entries: [] }, slice: {}, modelsVersion: 0 });
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("status", (e) => setLive((l) => ({ ...l, status: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener("queue", (e) => setLive((l) => ({ ...l, queue: JSON.parse((e as MessageEvent).data) })));
    es.addEventListener("models", () => setLive((l) => ({ ...l, modelsVersion: l.modelsVersion + 1 })));
    es.addEventListener("slice", (e) => {
      const ev: SliceEvent = JSON.parse((e as MessageEvent).data);
      setLive((l) => {
        const prev = ev.line.startsWith("Slicing jobs/") ? [] : l.slice[ev.job] ?? [];
        return { ...l, slice: { ...l.slice, [ev.job]: [...prev, ev].slice(-200) } };
      });
    });
    return () => es.close();
  }, []);
  return live;
}

export function useModels(version: number): Model[] | null {
  const [models, setModels] = useState<Model[] | null>(null);
  useEffect(() => {
    api<Model[]>("/api/models").then(setModels).catch(() => setModels([]));
  }, [version]);
  return models;
}

// ---- formatting ----

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
