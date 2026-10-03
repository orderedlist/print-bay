// Starting prints and the copy queue (ported from scripts/run.py).
//
// Each copy is one queue entry. Copies never start on their own: someone has to
// confirm the bed is clear first, the same rule as run.py's prompt between copies.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CACHE } from "./config.js";
import { publish } from "./events.js";
import { COLORS, gcodePath, getJob, isStale } from "./jobs.js";
import * as moonraker from "./moonraker.js";
import { slice } from "./slice.js";

const MAX_COLOR_DISTANCE = 120;

export interface QueueEntry {
  id: string;
  job: string;
  color: string;
  hex: string;
  slot: string;
  filename: string; // already uploaded to the printer
  copy: number;
  of: number;
}

interface QueueState { active: QueueEntry | null; entries: QueueEntry[] }

const QUEUE_FILE = path.join(CACHE, "queue.json");
let state: QueueState = fs.existsSync(QUEUE_FILE)
  ? JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"))
  : { active: null, entries: [] };

function save() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  publish("queue", state);
}

export const getQueue = () => state;

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function rgb(hex: string) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function findSlot(color: string, slots: moonraker.Slot[]): moonraker.Slot {
  const target = COLORS[color.toLowerCase()] ?? color;
  if (!/^#?[0-9a-f]{6}$/i.test(target)) throw fail(`Unknown color "${color}"`);
  if (!slots.length) throw fail("The CFS reports no filament loaded", 409);
  const distance = (s: moonraker.Slot) =>
    Math.hypot(...rgb(s.color).map((c, i) => c - rgb(target)[i]));
  const best = slots.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  if (distance(best) > MAX_COLOR_DISTANCE)
    throw fail(`No ${color} loaded (have ${slots.map((s) => `${s.slot} ${s.color}`).join(", ")})`, 409);
  return best;
}

/** Copy of single-tool G-code that pulls from the given CFS slot. */
function forSlot(gcode: string, slot: moonraker.Slot): string {
  const text = fs.readFileSync(gcode, "utf8");
  const tools = new Set([...text.matchAll(/^T(\d+)\s*$/gm)].map((m) => m[1]));
  if (tools.size > 1) throw fail(`${path.basename(gcode)} uses tools ${[...tools].join(", ")}; only single-color jobs are supported`);
  const out = gcode.replace(/\.gcode$/, `-${slot.slot}.gcode`);
  fs.writeFileSync(out, text.replace(/^T\d+\s*$/gm, `T${slot.tool}`));
  return out;
}

async function startEntry(entry: QueueEntry) {
  await moonraker.start(entry.filename);
  state.active = entry;
}

export async function print(opts: { job: string; color: string; copies: number; startNow: boolean }) {
  const job = getJob(opts.job);
  const copies = Math.max(1, Math.min(20, Math.floor(opts.copies)));
  const status = await moonraker.getStatus();
  if (!status.online) throw fail("Can't reach the printer", 503);
  const slot = findSlot(opts.color, status.slots);
  if (opts.startNow && !moonraker.IDLE_STATES.has(status.state))
    throw fail(`The printer is ${status.state}; add it to the queue instead`, 409);

  if (isStale(job)) await slice(job.name);
  const file = forSlot(gcodePath(job.name), slot);
  await moonraker.upload(file);

  const entries = Array.from({ length: copies }, (_, i): QueueEntry => ({
    id: randomUUID(), job: job.name, color: opts.color, hex: slot.color, slot: slot.slot,
    filename: path.basename(file), copy: i + 1, of: copies,
  }));
  let started = false;
  if (opts.startNow) {
    await startEntry(entries.shift()!);
    started = true;
  }
  state.entries.push(...entries);
  save();
  return { started, queued: entries.length, slot: slot.slot };
}

/** Start the next queued copy once someone confirms the bed is clear. */
export async function startNext() {
  const next = state.entries[0];
  if (!next) throw fail("The queue is empty", 409);
  const status = await moonraker.getStatus();
  if (!moonraker.IDLE_STATES.has(status.state)) throw fail(`The printer is ${status.state}`, 409);
  await startEntry(next);
  state.entries.shift();
  save();
  return next;
}

export function removeEntry(id: string) {
  state.entries = state.entries.filter((e) => e.id !== id);
  save();
}
