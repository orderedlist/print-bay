// The printers this computer knows, which one is in use, and following one to a new address.
//
// A printer is saved by address and by the name it gives itself (K2-9952). When the router
// hands it a new address (after a reboot, say), the one in use stops answering: the network
// is scanned for that name, and the saved address follows it.
import { K2_HOST, K2_NAME, normalizeHost, PRINTER_LABEL, readSettings, resolvePrinter, sameName, savedPrinters, writeSettings, type SavedPrinter, type Settings } from "./config.js";
import * as moonraker from "./moonraker.js";
import * as nozzle from "./nozzle.js";
import * as printing from "./printing.js";

export interface KnownPrinter extends SavedPrinter { active: boolean }

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

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

/** A print is on its way to the printer in use: switching now would send the rest of it elsewhere. */
function steady() {
  if (printing.isSending()) throw fail(`Still sending a print to ${PRINTER_LABEL}. Switch once it's sent.`, 409);
}

/** What was kept for a printer by its address (queued copies, its nozzle) is kept by its name once it has one. */
function named(host: string, name: string | undefined) {
  if (!name) return;
  printing.rekey(host, name);
  nozzle.rekey(host, name);
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
  const answered = await moonraker.probe(host).then((info) => info.hostname, () => undefined);
  steady();
  const s = readSettings();
  const name = answered ?? savedPrinters(s).find((p) => p.host === host)?.name; // off: the name it had, or named once it answers
  save(s, putting({ host, name }, savedPrinters(s)), host);
  named(host, name);
}

/** Use another saved printer. */
export function use(host: string): void {
  const s = readSettings();
  if (resolvePrinter(s).source === "env") throw fail("K2_HOST sets the printer; unset it to switch here.", 409);
  if (!savedPrinters(s).some((p) => p.host === host)) throw fail("That printer isn't saved. Add it in Settings.", 404);
  if (host !== resolvePrinter(s).host) steady();
  save(s, savedPrinters(s), host);
}

/** Forget a saved printer; forgetting the one in use moves to the next saved one, if any. */
export function forget(host: string): void {
  const s = readSettings();
  if (host === resolvePrinter(s).host) steady();
  save(s, savedPrinters(s).filter((p) => p.host !== host));
}

/** Name a printer saved while it was off (or before names were kept) the first time it answers. */
function learnName(hostname: string | null): void {
  const host = K2_HOST;
  if (K2_NAME || !hostname || !host || resolvePrinter().source !== "settings") return;
  const s = readSettings();
  if (!savedPrinters(s).some((p) => p.host === host)) return;
  save(s, putting({ host, name: hostname }, savedPrinters(s)));
  named(host, hostname);
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
  named(host, moved.name);
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
export function onStatus(status: moonraker.PrinterStatus, moved: () => void): void {
  if (status.online) {
    offline = false;
    learnName(status.hostname);
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
