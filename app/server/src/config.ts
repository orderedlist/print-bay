import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// app/server/{src,dist}/config.* -> repo root
const here = path.dirname(fileURLToPath(import.meta.url));

/** The app's own code: scripts/, app/, and the starter profiles. */
export const APP_ROOT = process.env.PRINT_BAY_ROOT ?? path.resolve(here, "../../..");

/**
 * The user's library: models/, jobs/, profiles/, gcode/, costs.toml and the app's cache.
 * A checkout with its own jobs/ keeps using itself; anyone else gets a folder of their own.
 */
export const DATA = path.resolve(process.env.PRINT_BAY_DATA ?? (fs.existsSync(path.join(APP_ROOT, "jobs"))
  ? APP_ROOT : path.join(os.homedir(), "Library", "Application Support", "Print Bay")));
process.env.PRINT_BAY_DATA = DATA; // slicing, nurb, the checks CLI and Claude's tools all run as children

// What the environment said before the app set anything: it wins over settings.json.
const ENV0 = { ...process.env };

export const CACHE = process.env.PRINT_BAY_CACHE ?? path.join(DATA, ".cache", "app");
export const WEB_DIST = path.join(APP_ROOT, "app/web/dist");

export const PORT = Number(process.env.PORT ?? 8765);
export const HOST = process.env.BIND ?? "0.0.0.0"; // LAN, so a phone can use it

// ---- settings for this computer: the printer and where the tools are ----
// Kept in the library as settings.json, which git never commits (see repos.ts): another
// computer sharing the library has its own printer address and tool paths.

export const SETTINGS_FILE = path.join(DATA, "settings.json");
export type ToolName = "orca" | "openscad" | "claude" | "git" | "nurb";
export interface Settings { printer?: string; tools?: Partial<Record<ToolName, string>>; setupDone?: boolean }

export function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Settings; } catch { return {}; }
}

export function writeSettings(next: Settings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  applySettings();
}

/** A checkout that is its own library predates settings: it keeps the printer it always used. */
const LEGACY_PRINTER = DATA === path.resolve(APP_ROOT) ? "192.168.4.81:7125" : null;

/** "192.168.4.81" or "k2.local:7125" (Moonraker's port is 7125 unless given). */
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

export function resolvePrinter(settings = readSettings()): { host: string | null; source: Source } {
  if (ENV0.K2_HOST) return { host: ENV0.K2_HOST, source: "env" };
  if (settings.printer) return { host: settings.printer, source: "settings" };
  return { host: LEGACY_PRINTER, source: LEGACY_PRINTER ? "default" : "missing" };
}

// Live bindings: modules that import these see new values after applySettings().
export let K2_HOST: string | null = null;
export let MOONRAKER: string | null = null;
export let CAMERA_URL: string | null = null;
export let ORCA = "";
export let OPENSCAD = "";
export let CLAUDE = "";
export let GIT = "";
export let NURB_PYTHON = "";

/** Read settings.json (and the environment) into the values above, and into the environment children get. */
export function applySettings(): void {
  const s = readSettings();
  K2_HOST = resolvePrinter(s).host;
  MOONRAKER = K2_HOST ? `http://${K2_HOST}` : null;
  CAMERA_URL = K2_HOST ? `http://${K2_HOST.split(":")[0]}:8000/call/webrtc_local` : null;
  ORCA = resolveTool("orca", s).path;
  OPENSCAD = resolveTool("openscad", s).path;
  CLAUDE = resolveTool("claude", s).path;
  GIT = resolveTool("git", s).path;
  NURB_PYTHON = resolveTool("nurb", s).path;
  // nurb_part.py, and the terminal scripts if run from the app, read these
  Object.assign(process.env, { ORCA, OPENSCAD, NURB_PYTHON });
  if (K2_HOST) process.env.K2_HOST = K2_HOST; else delete process.env.K2_HOST;
}

// ---- the library's starting contents ----

/** A new library starts empty, with the K2 profiles and default rates the app ships with. Safe to run again. */
export function seedLibrary(): void {
  for (const dir of ["models", "jobs", "profiles", "gcode"]) fs.mkdirSync(path.join(DATA, dir), { recursive: true });
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
