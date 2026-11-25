// The printers this computer knows, which one is in use, and following one to a new address.
//
// A printer is saved by address and by the name it gives itself (K2-9952). When the router
// hands it a new address (after a reboot, say), the one in use stops answering: the network
// is scanned for that name, and the saved address follows it.
import { K2_HOST, K2_NAME, normalizeHost, readSettings, resolvePrinter, savedPrinters, writeSettings, type SavedPrinter, type Settings } from "./config.js";
import * as moonraker from "./moonraker.js";

export interface KnownPrinter extends SavedPrinter { active: boolean }

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sameName = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Every saved printer, marking the one in use. Empty while K2_HOST sets the printer. */
export function list(s = readSettings()): KnownPrinter[] {
  const { host, source } = resolvePrinter(s);
  if (source === "env") return [];
  return savedPrinters(s).map((p) => ({ ...p, active: p.host === host }));
}

/** `printers` with `me` in the place of what's saved at its address or under its name (the same printer at an older address). */
function putting(me: SavedPrinter, printers: SavedPrinter[]): SavedPrinter[] {
  const same = (p: SavedPrinter) => p.host === me.host || (!!me.name && sameName(p.name, me.name));
  const at = printers.findIndex(same);
  const rest = printers.filter((p) => !same(p));
  rest.splice(at < 0 ? rest.length : at, 0, me);
  return rest;
}

/** Save the printers and which is in use (the first, if the one in use was dropped). */
function save(s: Settings, printers: SavedPrinter[], active = s.printer) {
  s.printers = printers;
  s.printer = printers.some((p) => p.host === active) ? active : printers[0]?.host;
  if (!s.printer) delete s.printer;
  writeSettings(s);
}

/** Save a printer by address (named, if it answers) and use it. */
export async function add(input: string): Promise<void> {
  const host = normalizeHost(input);
  const name = await moonraker.probe(host).then((info) => info.hostname, () => undefined); // off: named once it answers
  const s = readSettings();
  save(s, putting({ host, name }, savedPrinters(s)), host);
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
  save(s, savedPrinters(s).filter((p) => p.host !== host));
}

/** Name a printer saved while it was off (or before names were kept) the first time it answers. */
let naming = false;
async function learnName(): Promise<void> {
  const host = K2_HOST;
  if (naming || K2_NAME || !host || resolvePrinter().source !== "settings") return;
  naming = true;
  try {
    const { hostname } = await moonraker.probe(host);
    const s = readSettings(); // read again: settings may have changed while it answered
    if (savedPrinters(s).some((p) => p.host === host)) save(s, putting({ host, name: hostname }, savedPrinters(s)));
  } catch { /* it'll answer on a later poll */ } finally { naming = false; }
}

/**
 * Look for the printer in use on the network and follow it to a new address. Matched by name;
 * a printer saved before names were kept has none, so with only it saved, the only printer
 * found is taken to be it. True when it moved.
 */
async function refind(): Promise<boolean> {
  const before = readSettings();
  const { host, source } = resolvePrinter(before);
  const saved = savedPrinters(before);
  const me = saved.find((p) => p.host === host);
  if (!host || !me || source !== "settings") return false;
  const found = await moonraker.scanForPrinters();
  const matches = me.name ? found.filter((f) => sameName(me.name, f.hostname)) : saved.length === 1 ? found : [];
  if (matches.length !== 1 || matches[0].host === host) return false; // two answering to one name: don't guess
  const moved = { host: matches[0].host, name: matches[0].hostname };
  const s = readSettings();
  if (resolvePrinter(s).host !== host) return false; // switched while scanning
  save(s, putting(moved, savedPrinters(s).map((p) => (p.host === host ? moved : p))), moved.host);
  return true;
}

// Scan soon after the printer stops answering (a reboot takes about a minute), then less and
// less often, so a printer that's just switched off isn't hunted every few seconds.
const FIRST_HUNT = 20_000;
const MAX_HUNT_GAP = 10 * 60_000;
let offline = false;
let nextHunt = 0;
let gap = FIRST_HUNT;
let hunting = false;

/** Called with each status poll: names a printer that answers, and hunts for one that doesn't. */
export function onStatus(online: boolean, moved: () => void): void {
  if (online) {
    offline = false;
    void learnName();
    return;
  }
  if (!offline) { offline = true; gap = FIRST_HUNT; nextHunt = Date.now() + FIRST_HUNT; }
  if (hunting || Date.now() < nextHunt) return;
  hunting = true;
  refind()
    .then((did) => { if (did) moved(); })
    .catch(() => {})
    .finally(() => { hunting = false; gap = Math.min(gap * 2, MAX_HUNT_GAP); nextHunt = Date.now() + gap; });
}

/** After the printer in use changes: hunt for the new one from scratch if it doesn't answer. */
export function reset(): void {
  offline = false;
}
