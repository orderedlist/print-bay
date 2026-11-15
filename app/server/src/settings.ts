// Setup and Settings: the printer, the tools the app shells out to, cost rates, and the library.
import fs from "node:fs";
import path from "node:path";
import {
  APP_ROOT, DATA, normalizeHost, readSettings, resolvePrinter, resolveTool, writeSettings,
  type Settings, type Source, type ToolName,
} from "./config.js";
import { rates, type Rates } from "./jobs.js";

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
  printer: { host: string | null; source: Source };
  tools: ToolStatus[];
  rates: Rates;
  library: { path: string; fresh: boolean };
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
    printer: resolvePrinter(s),
    tools,
    rates: rates(),
    library: { path: DATA, fresh: libraryFresh() },
    caps: { slice: ok("orca"), openscad: ok("openscad"), claude: ok("claude"), git: ok("git"), nurb: ok("nurb") },
  };
}

export interface SettingsUpdate {
  printer?: string | null; // "" or null clears it
  tools?: Partial<Record<ToolName, string | null>>; // null: find it again
  rates?: Partial<Rates>;
  setupDone?: boolean;
}

export function update(u: SettingsUpdate): SettingsView {
  const s = readSettings();
  if (u.printer !== undefined) {
    if (u.printer) s.printer = normalizeHost(u.printer);
    else delete s.printer;
  }
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
  writeSettings(s);
  return view();
}

function writeRates(r: Rates): void {
  for (const [k, v] of Object.entries(r)) if (typeof v !== "number" || !isFinite(v) || v < 0) throw fail(`${k}: use a number`);
  fs.writeFileSync(path.join(DATA, "costs.toml"), `# Rates for the viewer's cost estimates (also editable in Print Bay's Settings).
filament_per_kg = ${r.filament_per_kg}   # per kg of filament
printer_watts   = ${r.printer_watts}   # average draw while printing (K2: heated bed + hotend + fans)
power_per_kwh   = ${r.power_per_kwh}   # per kWh
`);
}
