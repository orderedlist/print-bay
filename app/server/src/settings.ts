// Setup and Settings: the printer, the tools the app shells out to, cost rates, and the library.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  APP_ROOT, chooseLibrary, DATA, DEFAULT_LIBRARY, LIBRARY_SOURCE, normalizeHost, readSettings, resolvePrinters, resolveTool, toSaved, writeSettings,
  type LibrarySource, type PrinterConfig, type Settings, type Source, type ToolName,
} from "./config.js";
import { rates, type Rates } from "./jobs.js";
import { sameIdentity, type FoundPrinter } from "./moonraker.js";

export interface ToolStatus {
  name: ToolName;
  label: string;
  purpose: string;
  required: boolean;
  path: string;
  source: Source;
  ok: boolean;
  problem: string | null;
  install: string;
}

export interface SettingsView {
  needsSetup: boolean;
  printers: { list: PrinterConfig[]; source: Source };
  tools: ToolStatus[];
  rates: Rates;
  /** `next`: chosen in Settings, used from the next start */
  library: { path: string; source: LibrarySource; fresh: boolean; next: string | null; default: string };
  /** what works on this computer, so the UI can hide the rest */
  caps: { slice: boolean; openscad: boolean; claude: boolean; git: boolean; nurb: boolean };
}

const TOOLS: { name: ToolName; label: string; purpose: string; required: boolean; install: string }[] = [
  { name: "orca", label: "OrcaSlicer", purpose: "Slices models into G-code", required: true, install: "Download it from orcaslicer.com and drag it to Applications." },
  { name: "openscad", label: "OpenSCAD", purpose: "Draws .scad models and their parameters", required: false, install: "brew install --cask openscad@snapshot" },
  { name: "claude", label: "Claude Code", purpose: "Designs and edits models with Claude", required: false, install: "Install Claude Code (claude.com/claude-code), then run claude once to sign in." },
  { name: "git", label: "Git", purpose: "Commits and pushes in Changes", required: false, install: "xcode-select --install" },
  { name: "nurb", label: "nurb", purpose: "Builds nurb (Python) parts", required: false, install: "Install the nurb app; it sets up its own Python." },
];

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function toolStatus(s: Settings): ToolStatus[] {
  return TOOLS.map((t) => {
    const { path: p, source } = resolveTool(t.name, s);
    const exists = path.isAbsolute(p) && fs.existsSync(p);
    const problem = exists ? null : "Not found";
    return { ...t, path: p, source, ok: !problem, problem };
  });
}

function libraryFresh(): boolean {
  const models = fs.readdirSync(path.join(DATA, "models"), { withFileTypes: true }).filter((d) => d.isDirectory());
  const jobs = fs.readdirSync(path.join(DATA, "jobs")).filter((f) => f.endsWith(".toml"));
  return !models.length && !jobs.length;
}

export function view(): SettingsView {
  const s = readSettings();
  const tools = toolStatus(s);
  const ok = (n: ToolName) => tools.find((t) => t.name === n)!.ok;
  return {
    // a checkout that is its own library was set up before settings existed
    needsSetup: !s.setupDone && path.resolve(DATA) !== path.resolve(APP_ROOT),
    printers: (({ printers, source }) => ({ list: printers, source }))(resolvePrinters(s)),
    tools,
    rates: rates(),
    library: { path: DATA, source: LIBRARY_SOURCE, fresh: libraryFresh(), next: nextLibrary, default: DEFAULT_LIBRARY },
    caps: { slice: ok("orca"), openscad: ok("openscad"), claude: ok("claude"), git: ok("git"), nurb: ok("nurb") },
  };
}

let nextLibrary: string | null = null; // chosen this run; the server reads the location when it starts

export interface SettingsUpdate {
  library?: string | null; // a folder to use from the next start; null: the default
  tools?: Partial<Record<ToolName, string | null>>; // null: find it again
  rates?: Partial<Rates>;
  setupDone?: boolean;
}

export function update(u: SettingsUpdate): SettingsView {
  const s = readSettings();
  if (u.tools) {
    s.tools = { ...s.tools };
    for (const [name, value] of Object.entries(u.tools) as [ToolName, string | null][]) {
      if (!TOOLS.some((t) => t.name === name)) throw fail(`Unknown tool ${name}`);
      if (!value) { delete s.tools[name]; continue; }
      const p = value.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
      if (!path.isAbsolute(p) || !fs.existsSync(p)) throw fail(`Nothing at ${p}. Use the full path to the program.`);
      // OrcaSlicer.app picked in Finder: use the binary inside it
      s.tools[name] = p.endsWith(".app") ? path.join(p, "Contents/MacOS", path.basename(p, ".app")) : p;
    }
  }
  if (u.rates) writeRates({ ...rates(), ...u.rates });
  if (u.setupDone !== undefined) s.setupDone = u.setupDone;
  if (u.library !== undefined) {
    if (LIBRARY_SOURCE === "env") throw fail("PRINT_BAY_DATA sets the library; unset it to choose one here.", 409);
    const raw = u.library?.trim() ?? "";
    if (raw && !raw.startsWith("/") && !raw.startsWith("~/")) throw fail("Use the folder's full path");
    const dir = raw ? path.resolve(raw.replace(/^~(?=\/)/, process.env.HOME ?? "~")) : null;
    if (dir) {
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw fail(`${dir} is a file, not a folder`);
      if (!fs.existsSync(path.dirname(dir))) throw fail(`There's no folder ${path.dirname(dir)}`);
    }
    chooseLibrary(dir);
    // with no choice, the next start uses this checkout (if it has jobs/) or the default folder
    nextLibrary = dir ?? (fs.existsSync(path.join(APP_ROOT, "jobs")) ? APP_ROOT : DEFAULT_LIBRARY);
    if (path.resolve(nextLibrary) === path.resolve(DATA)) nextLibrary = null;
  }
  writeSettings(s);
  return view();
}

// ---- printers ----

export interface PrinterInput { name?: string; host?: string; hostname?: string | null; mac?: string | null }

/** The printers to change: settings.json's list, or the one printer kept from before there could be several. */
function editablePrinters(): { s: Settings; list: PrinterConfig[] } {
  const s = readSettings();
  const { printers, source } = resolvePrinters(s);
  if (source === "env") throw fail("K2_HOST sets the printer; unset it to set up printers here.", 409);
  return { s, list: printers.map((p) => ({ ...p })) };
}

function savePrinters(s: Settings, list: PrinterConfig[]): PrinterConfig[] {
  // Print Bay 0.3 uses one printer at a time, `printer`: keep the one it was using (at its address now), else the first
  const inUse = resolvePrinters(s).printers.find((p) => p.host === s.printer)?.id;
  Object.assign(s, toSaved(list));
  s.printer = list.find((p) => p.id === inUse)?.host ?? list[0]?.host;
  if (!s.printer) delete s.printer;
  writeSettings(s);
  return list;
}

function checkName(raw: string | undefined, list: PrinterConfig[], self?: string): string {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw fail("Give the printer a name");
  if (name.length > 40) throw fail("Keep the name under 40 characters");
  if (list.some((p) => p.id !== self && p.name.toLowerCase() === name.toLowerCase())) throw fail(`There's already a printer called ${name}`);
  return name;
}

function checkHost(raw: string | undefined, list: PrinterConfig[], self?: string): string {
  const host = normalizeHost(raw ?? "");
  const other = list.find((p) => p.id !== self && p.host === host);
  if (other) throw fail(`${other.name} is already at ${host.replace(/:7125$/, "")}`);
  return host;
}

export function addPrinter(input: PrinterInput): PrinterConfig {
  const { s, list } = editablePrinters();
  const p: PrinterConfig = { id: randomBytes(4).toString("hex"), name: checkName(input.name, list), host: checkHost(input.host, list) };
  if (input.hostname) p.hostname = input.hostname;
  if (input.mac) p.mac = input.mac;
  savePrinters(s, [...list, p]);
  return p;
}

export function updatePrinter(id: string, input: PrinterInput): PrinterConfig {
  const { s, list } = editablePrinters();
  const p = list.find((x) => x.id === id);
  if (!p) throw fail(`No printer ${id}`, 404);
  if (input.name !== undefined) p.name = checkName(input.name, list, id);
  if (input.host !== undefined && normalizeHost(input.host) !== p.host) p.host = checkHost(input.host, list, id);
  if (input.hostname) p.hostname = input.hostname;
  else if (input.hostname === null) delete p.hostname;
  if (input.mac) p.mac = input.mac;
  else if (input.mac === null) delete p.mac;
  savePrinters(s, list);
  return p;
}

export interface Moved { id: string; name: string; from: string; to: string }

/**
 * After a scan: learn what identifies each saved printer it found at its address, and follow any
 * saved printer that turns up at a new one. Returns the printers that moved.
 */
export function applyScan(found: FoundPrinter[]): Moved[] {
  const s = readSettings();
  const { printers, source } = resolvePrinters(s);
  if (source === "env" || source === "missing") return [];
  const known = (p: PrinterConfig) => !!(p.mac || p.hostname);
  const moved: Moved[] = [];
  const list = printers.map((p): PrinterConfig => {
    // a known printer is wherever its MAC or name turns up, even if the router swapped two printers' addresses
    // one not known yet is whoever answers at its address, unless that's another saved printer
    // and the only printer saved, with nothing to know it by, is the only one found (as 0.3 did)
    const f = known(p) ? found.find((x) => sameIdentity(p, x))
      : found.find((x) => x.host === p.host && !printers.some((o) => o !== p && known(o) && sameIdentity(o, x)))
        ?? (printers.length === 1 && found.length === 1 ? found[0] : undefined);
    if (!f) return p;
    if (f.host !== p.host) moved.push({ id: p.id, name: p.name, from: p.host, to: f.host });
    return { ...p, host: f.host, hostname: p.hostname ?? f.hostname, ...(p.mac || f.mac ? { mac: p.mac ?? f.mac! } : {}) };
  });
  // a printer not seen keeps its old address even if another has moved onto it: polling there finds the other printer, says so, and keeps looking
  if (JSON.stringify(list) !== JSON.stringify(printers)) savePrinters(s, list);
  return moved;
}

export function removePrinter(id: string): void {
  const { s, list } = editablePrinters();
  if (!list.some((p) => p.id === id)) throw fail(`No printer ${id}`, 404);
  savePrinters(s, list.filter((p) => p.id !== id));
}

function writeRates(r: Rates): void {
  for (const [k, v] of Object.entries(r)) if (typeof v !== "number" || !isFinite(v) || v < 0) throw fail(`${k}: use a number`);
  fs.writeFileSync(path.join(DATA, "costs.toml"), `# Rates for the viewer's cost estimates (also editable in Print Bay's Settings).
filament_per_kg = ${r.filament_per_kg}   # per kg of filament
printer_watts   = ${r.printer_watts}   # average draw while printing (K2: heated bed + hotend + fans)
power_per_kwh   = ${r.power_per_kwh}   # per kWh
`);
}
