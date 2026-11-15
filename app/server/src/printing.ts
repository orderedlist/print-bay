// Starting prints and the copy queue (ported from scripts/run.py).
//
// Each copy is one queue entry. Copies never start on their own: someone has to
// confirm the bed is clear first, the same rule as run.py's prompt between copies.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CACHE } from "./config.js";
import { publish } from "./events.js";
import { gcodePath, getJob, hexFor, isMaterial, isStale, type Material } from "./jobs.js";
import * as moonraker from "./moonraker.js";
import { slice } from "./slice.js";

const MAX_COLOR_DISTANCE = 120;
const SAME_COLOR = 20; // closer than this, two spools are the same colour and a colour alone can't pick between them

export interface QueueEntry {
  id: string;
  job: string;
  color: string;
  hex: string;
  hexes?: string[]; // every colour, for multi-colour prints
  slot: string;
  material?: Material; // when not PLA
  perPlate?: number; // parts on each plate, when more than one
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
  const target = hexFor(color);
  if (!/^#?[0-9a-f]{6}$/i.test(target)) throw fail(`Unknown color "${color}"`);
  if (!slots.length) throw fail("The CFS reports no filament loaded", 409);
  const distance = (s: moonraker.Slot) =>
    Math.hypot(...rgb(s.color).map((c, i) => c - rgb(target)[i]));
  const best = slots.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  if (distance(best) > MAX_COLOR_DISTANCE)
    throw fail(`No ${color} loaded (have ${slots.map((s) => `${s.slot} ${s.color}`).join(", ")})`, 409);
  const ties = slots.filter((s) => distance(s) - distance(best) < SAME_COLOR);
  if (ties.length > 1) // e.g. T1A and the outside spool both black: guessing could swap away from what's loaded
    throw fail(`${ties.map((s) => (s.slot === moonraker.OUTSIDE ? "the outside spool" : s.slot)).join(" and ")} are the same colour; pick the spool to print from`, 409);
  return best;
}

/**
 * Copy of the G-code whose filament i (T<i>) pulls from slots[i] in the CFS. The outside
 * spool has no tool number: its copy drops the tool changes, so the printer feeds whatever
 * is loaded (the same plain start Creality Print and Orca use for the spool holder).
 */
function forSlots(gcode: string, slots: moonraker.Slot[]): string {
  const text = fs.readFileSync(gcode, "utf8");
  const tools = [...text.matchAll(/^T(\d+)\s*$/gm)].map((m) => Number(m[1]));
  if (Math.max(0, ...tools) >= slots.length)
    throw fail(`${path.basename(gcode)} uses ${Math.max(...tools) + 1} filaments but ${slots.length} colour(s) were picked; re-slice it`);
  const outside = slots.some((s) => s.slot === moonraker.OUTSIDE);
  if (outside && (slots.length > 1 || new Set(tools).size > 1))
    throw fail("The outside spool can only feed a one-colour print: pick it for every part, or CFS spools");
  const out = gcode.replace(/\.gcode$/, `-${slots.map((s) => s.slot).join("-")}.gcode`);
  fs.writeFileSync(out, outside
    ? text.replace(/^T\d+\s*\n/gm, "")
    : text.replace(/^T(\d+)\s*$/gm, (_, i) => `T${slots[Number(i)].tool}`));
  return out;
}

async function startEntry(entry: QueueEntry) {
  await moonraker.start(entry.filename);
  state.active = entry;
}

/**
 * `color` is the spool for a one-colour job; `colors` gives each part of a
 * multi-colour job its spool (by part name), defaulting to the job's own colours.
 * `material` slices for that filament; left out, it's what the printer has a picked spool set as (wood, silk), else PLA.
 */
export async function print(opts: {
  job: string; color?: string; colors?: Record<string, string>;
  slot?: string; slots?: Record<string, string>; // the spools picked (T1A, EXT): exact where two hold the same colour
  copies: number; perPlate?: number; material?: string; startNow: boolean;
}) {
  const job = getJob(opts.job);
  const copies = Math.max(1, Math.min(20, Math.floor(opts.copies))); // plates, one after another
  const perPlate = Math.max(1, Math.min(400, Math.floor(opts.perPlate ?? 1)));
  const status = await moonraker.getStatus();
  if (!status.online) throw fail("Can't reach the printer", 503);
  const colors = job.parts.length ? job.parts.map((p) => opts.colors?.[p.name] ?? p.color) : [opts.color ?? job.color ?? ""];
  if (!colors.every(Boolean)) throw fail("Pick a colour");
  const keys = job.parts.length ? job.parts.map((p) => p.name) : [""];
  const slots = colors.map((c, i) => {
    const picked = job.parts.length ? opts.slots?.[keys[i]] : opts.slot;
    if (!picked) return findSlot(c, status.slots);
    const s = status.slots.find((x) => x.slot === picked);
    if (!s) throw fail(`The printer reports nothing in ${picked}`, 409);
    return s;
  });
  const slot = slots[0];
  // every part from the same spool: slice it as one colour, with no colour swaps (and the outside spool can feed it)
  const oneColor = slots.length > 1 && new Set(slots.map((s) => s.slot)).size === 1;
  const feeds = oneColor ? [slot] : slots;
  if (opts.material !== undefined && !isMaterial(opts.material)) throw fail(`Unknown material "${opts.material}"`);
  const material: Material = opts.material ?? slots.find((s) => s.material !== "pla")?.material ?? "pla";
  if (material !== "pla" && perPlate > 1) throw fail(`Several to a plate isn't set up for ${material} yet`);
  if (job.plate && perPlate > 1) throw fail("A plate is laid out already; print more of it as copies");
  if (opts.startNow && !moonraker.IDLE_STATES.has(status.state))
    throw fail(`The printer is ${status.state}; add it to the queue instead`, 409);

  if (isStale(job, perPlate, material, oneColor)) await slice(job.name, perPlate, material, oneColor);
  const file = forSlots(gcodePath(job.name, perPlate, material, undefined, oneColor), feeds);
  await moonraker.upload(file);

  const entries = Array.from({ length: copies }, (_, i): QueueEntry => ({
    id: randomUUID(), job: job.name, color: oneColor ? colors[0] : colors.join(" + "), hex: slot.color,
    ...(feeds.length > 1 ? { hexes: feeds.map((s) => s.color) } : {}), slot: feeds.map((s) => s.slot).join(" + "),
    ...(perPlate > 1 ? { perPlate } : {}), ...(material === "pla" ? {} : { material }),
    filename: path.basename(file), copy: i + 1, of: copies,
  }));
  let started = false;
  if (opts.startNow) {
    await startEntry(entries.shift()!);
    started = true;
  }
  state.entries.push(...entries);
  save();
  return { started, queued: entries.length, slot: feeds.map((s) => s.slot).join(" + ") };
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
