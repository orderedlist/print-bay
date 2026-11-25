// The printers this computer knows, which one is in use, and following one to a new address.
//
// A printer is saved by address, and by the name it gives itself (K2-360F) once it has answered.
// When the router hands it a new address (after a reboot, say), the one in use stops answering:
// the network is scanned for that name, and the saved address follows it.
import { normalizeHost, readSettings, resolvePrinter, savedPrinters, writeSettings, type SavedPrinter, type Settings } from "./config.js";
import * as moonraker from "./moonraker.js";

export interface KnownPrinter extends SavedPrinter { active: boolean }

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sameName = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Every saved printer, marking the one in use. Empty while K2_HOST sets the printer. */
export function list(): KnownPrinter[] {
  const s = readSettings();
  const { host, source } = resolvePrinter(s);
  if (source === "env") return [];
  return savedPrinters(s).map((p) => ({ ...p, active: p.host === host }));
}

function save(s: Settings, printers: SavedPrinter[], active?: string | null) {
  s.printers = printers;
  if (active === null) delete s.printer;
  else if (active !== undefined) s.printer = active;
  writeSettings(s);
}

/** Save a printer by address (if it isn't already) and use it. */
export function add(input: string): void {
  const host = normalizeHost(input);
  const s = readSettings();
  const printers = savedPrinters(s);
  if (!printers.some((p) => p.host === host)) printers.push({ host });
  save(s, printers, host);
}

/** Use another saved printer. */
export function use(host: string): void {
  const s = readSettings();
  if (resolvePrinter(s).source === "env") throw fail("K2_HOST sets the printer; unset it to switch here.", 409);
  if (!savedPrinters(s).some((p) => p.host === host)) throw fail("That printer isn't saved. Add it in Settings.", 404);
  save(s, savedPrinters(s), host);
}

/** Forget a saved printer; forgetting the one in use moves to the next saved one, if any. */
export function forget(host: string): void {
  const s = readSettings();
  const printers = savedPrinters(s).filter((p) => p.host !== host);
  save(s, printers, s.printer === host ? printers[0]?.host ?? null : undefined);
}

/** The name the printer in use gives itself, saved the first time it answers. */
let naming = false;
async function learnName(): Promise<void> {
  const { host, source } = resolvePrinter();
  if (naming || !host || source !== "settings" || savedPrinters(readSettings()).find((p) => p.host === host)?.name) return;
  naming = true;
  try {
    const { hostname } = await moonraker.probe(host);
    const s = readSettings(); // read again: settings may have changed while it answered
    const printers = savedPrinters(s);
    const me = printers.find((p) => p.host === host);
    if (!me) return;
    me.name = hostname;
    // the same printer, saved before at an older address
    save(s, printers.filter((p) => p === me || !sameName(p.name, hostname)));
  } catch { /* it'll answer on a later poll */ } finally { naming = false; }
}

/**
 * Look for the printer in use on the network and follow it to a new address. Matched by name;
 * a printer saved before names were kept has none, so with only it saved, the only printer
 * found is taken to be it. Returns the new address, or null when it hasn't moved or isn't found.
 */
async function refind(): Promise<string | null> {
  const before = readSettings();
  const { host, source } = resolvePrinter(before);
  const saved = savedPrinters(before);
  const me = saved.find((p) => p.host === host);
  if (!host || !me || source !== "settings") return null;
  const found = await moonraker.scanForPrinters();
  const matches = me.name ? found.filter((f) => sameName(me.name, f.hostname)) : saved.length === 1 ? found : [];
  if (matches.length !== 1 || matches[0].host === host) return null; // two answering to one name: don't guess
  const moved = matches[0];
  const s = readSettings();
  if (resolvePrinter(s).host !== host) return null; // switched while scanning
  const printers = savedPrinters(s).filter((p) => p.host !== moved.host); // a stale entry already at the new address
  const entry = printers.find((p) => p.host === host)!;
  entry.host = moved.host;
  entry.name = moved.hostname;
  save(s, printers, moved.host);
  return moved.host;
}

// Scan soon after the printer stops answering (a reboot takes about a minute), then less and
// less often, so a printer that's just switched off isn't hunted every few seconds.
const FIRST_HUNT = 20_000;
const MAX_HUNT_GAP = 10 * 60_000;
let offlineSince: number | null = null;
let nextHunt = 0;
let gap = FIRST_HUNT;
let hunting = false;

/** Called with each status poll: names a printer that answers, and hunts for one that doesn't. */
export function onStatus(online: boolean, moved: (host: string) => void): void {
  if (online) {
    offlineSince = null;
    void learnName();
    return;
  }
  const now = Date.now();
  if (offlineSince === null) { offlineSince = now; gap = FIRST_HUNT; nextHunt = now + FIRST_HUNT; }
  if (hunting || now < nextHunt) return;
  hunting = true;
  refind()
    .then((host) => { if (host) moved(host); })
    .catch(() => {})
    .finally(() => { hunting = false; gap = Math.min(gap * 2, MAX_HUNT_GAP); nextHunt = Date.now() + gap; });
}

/** After the printer in use changes: hunt for the new one from scratch if it doesn't answer. */
export function reset(): void {
  offlineSince = null;
}
