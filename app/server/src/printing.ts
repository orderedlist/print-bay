// Starting prints and the copy queue (ported from scripts/run.py).
//
// Each copy is one queue entry. Copies never start on their own: someone has to
// confirm the bed is clear first, the same rule as run.py's prompt between copies.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CACHE, PRINTERS } from "./config.js";
import { publish } from "./events.js";
import { gcodePath, getJob, hexFor, isMaterial, isStale, type Material } from "./jobs.js";
import * as moonraker from "./moonraker.js";
import { printer, refresh } from "./printers.js";
import { slice } from "./slice.js";
import { getNozzle } from "./nozzle.js";

const MAX_COLOR_DISTANCE = 120;
const SAME_COLOR = 20; // closer than this, two spools are the same colour and a colour alone can't pick between them

export interface QueueEntry {
  id: string;
  printer: string; // the printer's id: the file is uploaded to it
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

/** `active`: what each printer was last started on, by printer id. */
interface QueueState { active: Record<string, QueueEntry>; entries: QueueEntry[] }

const QUEUE_FILE = path.join(CACHE, "queue.json");
let state: QueueState = load();

/**
 * The queue as saved. Print Bay 0.3 kept `running`, a list of what each printer last started, with
 * copies tagged by the printer's name or address (its id here); before that, `active` and untagged
 * copies were all the first printer's.
 */
function load(): QueueState {
  if (!fs.existsSync(QUEUE_FILE)) return { active: {}, entries: [] };
  const saved = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")) as { active?: unknown; running?: QueueEntry[]; entries?: QueueEntry[] };
  const first = PRINTERS[0]?.id ?? "";
  const old = (e: QueueEntry): QueueEntry => (e.printer ? e : { ...e, printer: first });
  const active: Record<string, QueueEntry> = saved.running ? Object.fromEntries(saved.running.map(old).map((e) => [e.printer, e]))
    : !saved.active ? {}
    : "filename" in (saved.active as object) ? { [first]: old(saved.active as QueueEntry) }
    : saved.active as Record<string, QueueEntry>;
  return { active, entries: (saved.entries ?? []).map(old) };
}

function save() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  publish("queue", state);
}

export const getQueue = () => state;

/** A job was renamed: queued and last-started entries follow it. */
export function renameJobInQueue(from: string, to: string) {
  const all = [...state.entries, ...Object.values(state.active)];
  if (!all.some((e) => e.job === from)) return;
  for (const e of all) if (e.job === from) e.job = to;
  save();
}

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
  await moonraker.start(printer(entry.printer).host, entry.filename);
  state.active[entry.printer] = entry;
}

/**
 * `color` is the spool for a one-colour job; `colors` gives each part of a
 * multi-colour job its spool (by part name), defaulting to the job's own colours.
 * `material` slices for that filament; left out, it's what the printer has a picked spool set as (wood, silk; stone has no Creality id, so it's picked), else PLA.
 */
export async function print(opts: {
  printer?: string; // its id; may be left out when there's only one
  job: string; color?: string; colors?: Record<string, string>;
  slot?: string; slots?: Record<string, string>; // the spools picked (T1A, EXT): exact where two hold the same colour
  copies: number; perPlate?: number; material?: string; startNow: boolean;
}) {
  const job = getJob(opts.job);
  const copies = Math.max(1, Math.min(20, Math.floor(opts.copies))); // plates, one after another
  const perPlate = Math.max(1, Math.min(400, Math.floor(opts.perPlate ?? 1)));
  const target = printer(opts.printer);
  const status = await refresh(target.id);
  if (!status.online) throw fail(`Can't reach ${target.name}`, 503);
  const colors = job.parts.length ? job.parts.map((p) => opts.colors?.[p.name] ?? p.color) : [opts.color ?? job.color ?? ""];
  if (!colors.every(Boolean)) throw fail("Pick a colour");
  const keys = job.parts.length ? job.parts.map((p) => p.name) : [""];
  const slots = colors.map((c, i) => {
    const picked = job.parts.length ? opts.slots?.[keys[i]] : opts.slot;
    if (!picked) return findSlot(c, status.slots);
    const s = status.slots.find((x) => x.slot === picked);
    if (!s) throw fail(`${target.name} reports nothing in ${picked}`, 409);
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
    throw fail(`${target.name} is ${status.state}; add it to the queue instead`, 409);

  const nozzle = getNozzle(target.id); // sliced for the nozzle on the printer it's going to
  if (isStale(job, perPlate, material, oneColor, nozzle)) await slice(job.name, perPlate, material, oneColor, nozzle);
  const file = forSlots(gcodePath(job.name, perPlate, material, nozzle, oneColor), feeds);
  // slicing can take a while: check it's still that printer at that address before sending
  const now = await refresh(target.id);
  if (!now.online) throw fail(`Can't reach ${target.name} now`, 503);
  if (opts.startNow && !moonraker.IDLE_STATES.has(now.state)) throw fail(`${target.name} is ${now.state} now; add it to the queue instead`, 409);
  await moonraker.upload(printer(target.id).host, file);

  const entries = Array.from({ length: copies }, (_, i): QueueEntry => ({
    id: randomUUID(), printer: target.id, job: job.name, color: oneColor ? colors[0] : colors.join(" + "), hex: slot.color,
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

/** Start a printer's next queued copy once someone confirms its bed is clear. */
export async function startNext(printerId: string) {
  const p = printer(printerId);
  const next = state.entries.find((e) => e.printer === p.id);
  if (!next) throw fail(`Nothing queued for ${p.name}`, 409);
  const status = await refresh(p.id);
  if (!moonraker.IDLE_STATES.has(status.state)) throw fail(`${p.name} is ${status.state}`, 409);
  await startEntry(next);
  state.entries = state.entries.filter((e) => e !== next);
  save();
  return next;
}

/** A printer was removed in Settings: its queue goes with it (the files were uploaded to it). */
export function forgetPrinter(id: string) {
  delete state.active[id];
  state.entries = state.entries.filter((e) => e.printer !== id);
  save();
}

export function removeEntry(id: string) {
  state.entries = state.entries.filter((e) => e.id !== id);
  save();
}
