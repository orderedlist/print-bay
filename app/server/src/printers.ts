// The printers this computer prints to, each polled for its status.
import { cameraUrl, PRINTERS, type PrinterConfig } from "./config.js";
import { publish } from "./events.js";
import * as moonraker from "./moonraker.js";
import * as settings from "./settings.js";

const LOOK_AFTER_MS = 30_000; // offline this long: it may have a new address, so look for it
const LOOK_EVERY_MS = 3 * 60_000; // at most this often: a scan knocks on a thousand addresses

export interface PrinterView {
  id: string;
  name: string;
  host: string;
  hostname: string | null;
  camera: string;
  status: moonraker.PrinterStatus;
}

const statuses = new Map<string, moonraker.PrinterStatus>();
const verified = new Map<string, string>(); // printer id → the address it was last confirmed at
const polls = new Map<string, { host: string; timer: NodeJS.Timeout | null; stopped: boolean }>();

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function view(): PrinterView[] {
  return PRINTERS.map((p) => ({
    id: p.id, name: p.name, host: p.host, hostname: p.hostname ?? null, camera: cameraUrl(p.host),
    status: statuses.get(p.id) ?? { ...moonraker.OFFLINE, message: "Connecting to the printer…" },
  }));
}

/** A printer by id; with none given, the only one there is. */
export function printer(id?: string | null): PrinterConfig {
  if (!PRINTERS.length) throw fail("No printer set up yet. Add one in Settings.", 409);
  if (!id) {
    if (PRINTERS.length > 1) throw fail("Pick a printer");
    return PRINTERS[0];
  }
  const p = PRINTERS.find((x) => x.id === id);
  if (!p) throw fail(`No printer ${id}. It may have been removed in Settings.`, 404);
  return p;
}

const ELSEWHERE = "Another printer answers at this address now. Looking for this one…";

/**
 * A printer's status, once it's confirmed that the printer answering at its address is this one
 * (after a start or an outage the router may have handed its address to the other printer).
 */
async function statusOf(id: string, host: string): Promise<moonraker.PrinterStatus> {
  const s = await moonraker.getStatus(host);
  if (!s.online) { verified.delete(id); return s; }
  if (verified.get(id) === host) return s;
  if (!(await isStill(id, host))) return { ...moonraker.OFFLINE, message: ELSEWHERE };
  verified.set(id, host);
  return s;
}

/** Ask a printer now, rather than at its next poll. */
export async function refresh(id: string): Promise<moonraker.PrinterStatus> {
  const p = printer(id);
  const s = await statusOf(id, p.host);
  if (PRINTERS.some((x) => x.id === id && x.host === p.host)) { statuses.set(id, s); publish("printers", view()); }
  return s;
}

/**
 * Poll every printer in settings, each every 2 s after its last answer (a slow printer never has
 * requests piling up). Call again after settings change: new printers start, removed ones stop.
 */
export function sync(): void {
  for (const [id, poll] of polls) {
    const p = PRINTERS.find((x) => x.id === id);
    if (p?.host === poll.host) continue;
    poll.stopped = true;
    if (poll.timer) clearTimeout(poll.timer);
    polls.delete(id);
    statuses.delete(id);
    verified.delete(id);
  }
  for (const p of PRINTERS) {
    if (polls.has(p.id)) continue;
    const poll = { host: p.host, timer: null as NodeJS.Timeout | null, stopped: false };
    polls.set(p.id, poll);
    let offlineSince: number | null = null;
    const tick = async () => {
      const s = await statusOf(p.id, poll.host);
      if (poll.stopped) return;
      statuses.set(p.id, s);
      publish("printers", view());
      if (s.online) offlineSince = null;
      else {
        // someone else at its address: look straight away; just not answering: give it a moment first
        const elsewhere = s.message === ELSEWHERE && offlineSince === null;
        offlineSince ??= Date.now();
        if (elsewhere || Date.now() - offlineSince > LOOK_AFTER_MS) await lookFor(p.id, elsewhere);
      }
      if (!poll.stopped) poll.timer = setTimeout(tick, 2000);
    };
    void tick();
  }
  publish("printers", view());
}

/**
 * Whether the printer answering at `host` is the one saved there. A printer not yet known by its MAC
 * and name gets them remembered now, so it can be found again if it moves.
 */
async function isStill(id: string, host: string): Promise<boolean> {
  try {
    const found = await moonraker.identify(host);
    const p = PRINTERS.find((x) => x.id === id);
    if (p?.host !== host) return true; // changed meanwhile: the next poll is at the new address
    if (!found.hostname) return true;
    const who = { mac: found.mac, hostname: found.hostname };
    if ((p.mac || p.hostname) && !moonraker.sameIdentity(p, who)) return false;
    if (PRINTERS.some((o) => o.id !== id && (o.mac || o.hostname) && moonraker.sameIdentity(o, who))) return false; // another saved printer moved here
    if ((found.hostname && !p.hostname) || (found.mac && !p.mac))
      settings.updatePrinter(id, { ...(found.hostname && !p.hostname ? { hostname: found.hostname } : {}), ...(found.mac && !p.mac ? { mac: found.mac } : {}) });
  } catch { /* no answer to the identity question, or K2_HOST sets the printer: carry on */ }
  return true;
}

let lastLook = 0;
/** A known printer stopped answering: scan for it (now and then), and follow it to its new address. */
async function lookFor(id: string, now = false): Promise<void> {
  const p = PRINTERS.find((x) => x.id === id);
  if (!p || (!p.mac && !p.hostname) || (!now && Date.now() - lastLook < LOOK_EVERY_MS)) return;
  lastLook = Date.now();
  try {
    const moved = settings.applyScan(await moonraker.scanForPrinters());
    if (moved.length) {
      for (const m of moved) console.warn(`${m.name} moved from ${m.from} to ${m.to}`);
      sync();
    }
  } catch { /* macOS blocking the network, say: try again later */ }
}

export function stop(): void {
  for (const poll of polls.values()) { poll.stopped = true; if (poll.timer) clearTimeout(poll.timer); }
  polls.clear();
}
