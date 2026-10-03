// Mirrors of the server's API shapes (app/server/src). Keep in sync by hand.

export interface Slot { slot: string; tool: number; color: string; remain: number }

export interface PrinterStatus {
  online: boolean;
  state: string;
  filename: string;
  progress: number;
  printSeconds: number;
  etaSeconds: number | null;
  layer: { current: number | null; total: number | null };
  nozzle: { temp: number; target: number };
  bed: { temp: number; target: number };
  slots: Slot[];
  message: string;
}

export interface Cost { filament: number; power: number; total: number }
export interface Stats { time: string; seconds: number; grams: number; cost: Cost; slicedAt: number }

export interface ModelJob {
  name: string;
  file: string;
  color: string | null;
  hex: string | null;
  copies: number;
  stats: Stats | null;
  stale: boolean;
  slicing: boolean;
}

export interface Model { id: string; file: string | null; kind: string | null; meshKey: string; source: string; jobs: ModelJob[] }

export interface ScadParam { name: string; default: string; value: string; comment: string }

export interface QueueEntry {
  id: string; job: string; color: string; hex: string; slot: string; filename: string; copy: number; of: number;
}
export interface QueueState { active: QueueEntry | null; entries: QueueEntry[] }

export interface SliceEvent { job: string; state: "running" | "done" | "failed"; line: string }

export const IDLE_STATES = new Set(["standby", "complete", "cancelled", "error"]);

export interface Finding {
  rule: string;
  severity: "fail" | "warn" | "info";
  message: string;
  detail: string;
  at: [number, number, number];
}
export interface CheckReport { findings: Finding[]; size: [number, number, number]; triangles: number; supports: boolean }

export type AgentEntry =
  | { role: "user"; text: string; uploads: string[] }
  | { role: "assistant"; text: string }
  | { role: "tool"; label: string; ok: boolean | null; id: string }
  | { role: "note"; text: string; error?: boolean };

export interface AgentSession {
  id: string;
  kind: "edit" | "new";
  modelId: string | null;
  job: string | null;
  claudeSessionId: string | null;
  transcript: AgentEntry[];
  running: boolean;
  turns: number;
  cost: number;
  createdAt: number;
}
