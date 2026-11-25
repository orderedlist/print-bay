// Mirrors of the server's API shapes (app/server/src). Keep in sync by hand.

/** What a spool is made of, as far as slicing cares (the printer's setting for the slot). */
export type Material = "pla" | "wood" | "silk" | "stone";
export const MATERIAL_NAMES: Record<Material, string> = { pla: "PLA", wood: "Wood", silk: "Silk", stone: "Stone" };
/** A spool the printer reports: a CFS slot (T1A..T4D), or "EXT", the holder outside it (remain unknown). */
export interface Slot { slot: string; tool: number; color: string; remain: number | null; material: Material }
export const slotName = (slot: string) => (slot === "EXT" ? "outside spool" : slot);

export interface PrinterStatus {
  printer: string | null; // the one in use: its name, or its address until it has answered
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
  label: string | null; // a part of a multi-part model, as its picker shows it ("Plant 3")
  file: string;
  color: string | null;
  hex: string | null;
  parts: { name: string; color: string; hex: string }[]; // more than one: a multi-colour print
  copies: number;
  stats: Stats | null;
  stale: boolean;
  slicing: boolean;
  plates: { perPlate: number; stats: Stats | null; stale: boolean }[]; // slices with several on one plate
  materials: Record<Exclude<Material, "pla">, { stats: Stats | null; stale: boolean }>; // sliced for a wood-fill, silk or stone spool
  plate: { job: string; count: number }[] | null; // a plate of the model's parts: what's on it
  oneColor: Record<Material, { stats: Stats | null; stale: boolean }> | null; // a multi-colour job sliced for one spool
}

export interface Model { id: string; file: string | null; kind: string | null; meshKey: string; source: string; jobs: ModelJob[] }

export interface ScadParam { name: string; default: string; value: string; comment: string }

export interface QueueEntry {
  id: string; job: string; color: string; hex: string; hexes?: string[]; slot: string; material?: Material; perPlate?: number; filename: string; copy: number; of: number;
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

export interface RepoChange { path: string; status: "added" | "modified" | "deleted" | "renamed" | "conflict" }
export interface Repo {
  id: "library";
  name: string;
  path: string;
  branch: string | null;
  remote: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: { hash: string; subject: string; at: number } | null;
  changes: RepoChange[];
  suggestion: string;
}

export type ToolName = "orca" | "openscad" | "claude" | "git" | "nurb";
export type SettingSource = "env" | "settings" | "found" | "default" | "missing";
export interface ToolStatus {
  name: ToolName; label: string; purpose: string; required: boolean;
  path: string; source: SettingSource; ok: boolean; problem: string | null; install: string;
}
export interface Rates { filament_per_kg: number; printer_watts: number; power_per_kwh: number }
export interface Caps { slice: boolean; openscad: boolean; claude: boolean; git: boolean; nurb: boolean }
/** A printer saved on this computer; `name` is what it calls itself, once it has answered. */
export interface SavedPrinter { host: string; name?: string; active: boolean }

export interface SettingsView {
  needsSetup: boolean;
  printer: { host: string | null; source: SettingSource; saved: SavedPrinter[] };
  tools: ToolStatus[];
  rates: Rates;
  library: { path: string; source: "env" | "chosen" | "checkout" | "default"; fresh: boolean; next: string | null; default: string };
  desktop: { restart: boolean; pickFolder: boolean };
  caps: Caps;
}

/** The desktop app's updater; null in a browser or run from a checkout. */
export interface UpdateStatus {
  version: string;
  state: "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  available: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
}
