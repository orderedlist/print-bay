import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// app/server/{src,dist}/config.* -> repo root
const here = path.dirname(fileURLToPath(import.meta.url));

/** The app's own code: scripts/, app/, and the starter profiles. */
export const APP_ROOT = process.env.PRINT_BAY_ROOT ?? path.resolve(here, "../../..");

/** Print Bay's folder for this computer (also Electron's own data folder, so the library goes in a subfolder). */
export const SUPPORT = path.join(os.homedir(), "Library", "Application Support", "Print Bay");
/** Which library to use, one path on one line: set in Settings, read by the terminal scripts too. */
export const LOCATION_FILE = path.join(SUPPORT, "library-location");
export const DEFAULT_LIBRARY = path.join(SUPPORT, "Library");

export type LibrarySource = "env" | "chosen" | "checkout" | "default";
function chosenLibrary(): string | null {
  try { return fs.readFileSync(LOCATION_FILE, "utf8").trim() || null; } catch { return null; }
}

/**
 * The user's library: models/, jobs/, plates/, profiles/, gcode/, costs.toml and the app's cache.
 * PRINT_BAY_DATA, else the folder chosen in Settings, else a checkout with its own jobs/
 * (it keeps using itself), else a folder of the user's own.
 */
export const [DATA, LIBRARY_SOURCE]: [string, LibrarySource] = (() => {
  if (process.env.PRINT_BAY_DATA) return [path.resolve(process.env.PRINT_BAY_DATA), "env"];
  const chosen = chosenLibrary();
  if (chosen) return [path.resolve(chosen), "chosen"];
  if (fs.existsSync(path.join(APP_ROOT, "jobs"))) return [path.resolve(APP_ROOT), "checkout"];
  return [DEFAULT_LIBRARY, "default"];
})();
process.env.PRINT_BAY_DATA = DATA; // slicing, nurb, the checks CLI and Claude's tools all run as children

/** Use another library from the next start (null: back to the default). */
export function chooseLibrary(dir: string | null): void {
  fs.mkdirSync(SUPPORT, { recursive: true });
  if (dir) fs.writeFileSync(LOCATION_FILE, path.resolve(dir) + "\n");
  else fs.rmSync(LOCATION_FILE, { force: true });
}

// What the environment said before the app set anything: it wins over settings.json.
const ENV0 = { ...process.env };

export const CACHE = process.env.PRINT_BAY_CACHE ?? path.join(DATA, ".cache", "app");
export const WEB_DIST = path.join(APP_ROOT, "app/web/dist");

export const PORT = Number(process.env.PORT ?? 8765);
export const HOST = process.env.BIND ?? "0.0.0.0"; // LAN, so a phone can use it

// ---- settings for this computer: its printers and where the tools are ----
// Kept in the library as settings.json, which git never commits (see repos.ts): another
// computer sharing the library has its own printers and tool paths.

export const SETTINGS_FILE = path.join(DATA, "settings.json");
export type ToolName = "orca" | "openscad" | "claude" | "git" | "nurb";
/**
 * A printer this computer prints to. `mac` (its Wi-Fi card) and `hostname` (what it calls itself, K2-360F)
 * don't change when the router hands it a new address: they find the printer again when it moves.
 */
export interface PrinterConfig { id: string; name: string; host: string; hostname?: string; mac?: string }
export interface Settings {
  printers?: PrinterConfig[];
  printer?: string; // before there could be several: the one printer's address
  tools?: Partial<Record<ToolName, string>>;
  setupDone?: boolean;
}

export function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Settings; } catch { return {}; }
}

export function writeSettings(next: Settings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  applySettings();
}

/** A checkout that is its own library predates settings: it keeps the printer it always used. */
const LEGACY_PRINTER = DATA === path.resolve(APP_ROOT) ? "192.168.4.42:7125" : null;

/** "192.168.4.42" or "k2-360f.local:7125" (Moonraker's port is 7125 unless given). */
export function normalizeHost(input: string): string {
  const h = input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h)) throw Object.assign(new Error("Use the printer's IP address or host name, like 192.168.1.50"), { statusCode: 400 });
  return h.includes(":") ? h : `${h}:7125`;
}

const HOME = os.homedir();
const NURB_ENV = path.join(HOME, "Library/Application Support/dev.nurb.desktop/env/bin");
/** Where each tool usually is. Apps launched from Finder get a minimal PATH, so look in the usual places. */
const CANDIDATES: Record<ToolName, string[]> = {
  orca: ["/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer", path.join(HOME, "Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")],
  openscad: ["/opt/homebrew/bin/openscad", "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD", "openscad"],
  claude: [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "claude"],
  git: ["/usr/bin/git", "/opt/homebrew/bin/git", "git"],
  nurb: [path.join(NURB_ENV, "python")],
};
const ENV_NAMES: Record<ToolName, string> = { orca: "ORCA", openscad: "OPENSCAD", claude: "CLAUDE", git: "GIT", nurb: "NURB_PYTHON" };

/** A bare command name, found on PATH (plus Homebrew's, which Finder-launched apps lack). */
function onPath(cmd: string): string | null {
  if (cmd.includes("/")) return fs.existsSync(cmd) ? cmd : null;
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) { const f = path.join(d, cmd); if (d && fs.existsSync(f)) return f; }
  return null;
}

export type Source = "env" | "settings" | "found" | "default" | "missing";
/** Where a tool is and why: the environment, settings.json, or a usual place. */
export function resolveTool(name: ToolName, settings = readSettings()): { path: string; source: Source } {
  const env = ENV0[ENV_NAMES[name]];
  if (env) return { path: env, source: "env" };
  const set = settings.tools?.[name];
  if (set) return { path: set, source: "settings" };
  const best = CANDIDATES[name].map(onPath).find((p): p is string => !!p);
  if (best) return { path: best, source: "found" };
  const fallback = CANDIDATES[name][CANDIDATES[name].length - 1];
  return { path: fallback, source: "missing" };
}

/** The printers and why: K2_HOST in the environment (one printer), settings.json, or the address a checkout always used. */
export function resolvePrinters(settings = readSettings()): { printers: PrinterConfig[]; source: Source } {
  const one = (host: string): PrinterConfig[] => [{ id: "k2", name: "K2", host }];
  if (ENV0.K2_HOST) return { printers: one(ENV0.K2_HOST), source: "env" };
  if (settings.printers) return { printers: settings.printers, source: "settings" };
  if (settings.printer) return { printers: one(settings.printer), source: "settings" };
  // no guess for anyone else: Setup scans the network for printers
  return { printers: LEGACY_PRINTER ? one(LEGACY_PRINTER) : [], source: LEGACY_PRINTER ? "default" : "missing" };
}

/** The K2's camera, a WebRTC endpoint beside Moonraker. */
export const cameraUrl = (host: string) => `http://${host.split(":")[0]}:8000/call/webrtc_local`;

// Live bindings: modules that import these see new values after applySettings().
export let PRINTERS: PrinterConfig[] = [];
export let ORCA = "";
export let OPENSCAD = "";
export let CLAUDE = "";
export let GIT = "";
export let NURB_PYTHON = "";

/** Read settings.json (and the environment) into the values above, and into the environment children get. */
export function applySettings(): void {
  const s = readSettings();
  PRINTERS = resolvePrinters(s).printers;
  ORCA = resolveTool("orca", s).path;
  OPENSCAD = resolveTool("openscad", s).path;
  CLAUDE = resolveTool("claude", s).path;
  GIT = resolveTool("git", s).path;
  NURB_PYTHON = resolveTool("nurb", s).path;
  // nurb_part.py, and the terminal scripts if run from the app, read these
  Object.assign(process.env, { ORCA, OPENSCAD, NURB_PYTHON });
  // the terminal scripts drive one printer: the first
  if (PRINTERS[0]) process.env.K2_HOST = PRINTERS[0].host; else delete process.env.K2_HOST;
}

// ---- the library's starting contents ----

/** A new library starts empty, with the K2 profiles and default rates the app ships with. Safe to run again. */
export function seedLibrary(): void {
  for (const dir of ["models", "jobs", "plates", "profiles", "gcode"]) fs.mkdirSync(path.join(DATA, dir), { recursive: true });
  if (!fs.existsSync(path.join(DATA, "costs.toml"))) fs.copyFileSync(path.join(APP_ROOT, "costs.toml"), path.join(DATA, "costs.toml"));
  for (const f of fs.readdirSync(path.join(APP_ROOT, "profiles")).filter((f) => f.endsWith(".json")))
    if (!fs.existsSync(path.join(DATA, "profiles", f))) fs.copyFileSync(path.join(APP_ROOT, "profiles", f), path.join(DATA, "profiles", f));
  fs.mkdirSync(CACHE, { recursive: true });
}

/**
 * Where Claude's tools (scripts/check, scripts/nurb) are reached from. Claude's permission rules
 * name a command by its path, which can't have spaces ("/Applications/Print Bay.app/..."), so a
 * path with spaces gets links from a folder without any.
 */
export const TOOL_BIN = (() => {
  const scripts = path.join(APP_ROOT, "scripts");
  if (!/\s/.test(scripts)) return scripts;
  const bin = path.join(HOME, "Library", "Caches", "PrintBay", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ["check", "nurb"]) {
    const link = path.join(bin, tool);
    const target = path.join(scripts, tool);
    let current: string | null = null;
    try { current = fs.readlinkSync(link); } catch { /* not there yet */ }
    if (current !== target) { fs.rmSync(link, { force: true }); fs.symlinkSync(target, link); }
  }
  return bin;
})();

seedLibrary();
applySettings();
