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

export const CACHE = process.env.PRINT_BAY_CACHE ?? path.join(DATA, ".cache", "app");
export const WEB_DIST = path.resolve(here, "../../web/dist");

export const K2_HOST = process.env.K2_HOST ?? "192.168.4.81:7125";
export const MOONRAKER = `http://${K2_HOST}`;
export const CAMERA_URL = `http://${K2_HOST.split(":")[0]}:8000/call/webrtc_local`;

export const PORT = Number(process.env.PORT ?? 8765);
export const HOST = process.env.BIND ?? "0.0.0.0"; // LAN, so a phone can use it

// Apps launched from Finder get a minimal PATH, so look in the usual places.
function firstExisting(...candidates: string[]): string {
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
}

export const OPENSCAD = process.env.OPENSCAD ?? firstExisting(
  "/opt/homebrew/bin/openscad",
  "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
  "openscad",
);
export const CLAUDE = process.env.CLAUDE ?? firstExisting(
  path.join(process.env.HOME ?? "", ".local/bin/claude"),
  "/opt/homebrew/bin/claude",
  "claude",
);
export const GIT = process.env.GIT ?? firstExisting("/usr/bin/git", "/opt/homebrew/bin/git", "git");
export const PYTHON = process.env.PYTHON ?? firstExisting(path.join(APP_ROOT, ".venv/bin/python"), "python3");
// nurb parts (Python/build123d) build with nurb's own environment, which the nurb app installs
const NURB_ENV = path.join(process.env.HOME ?? "", "Library/Application Support/dev.nurb.desktop/env/bin");
export const NURB_PYTHON = process.env.NURB_PYTHON ?? firstExisting(path.join(NURB_ENV, "python"), "python3");
export const NURB = process.env.NURB ?? firstExisting(path.join(NURB_ENV, "nurb"), "nurb");

// A new library starts empty, with the K2 profiles and default rates the app ships with.
for (const dir of ["models", "jobs", "profiles", "gcode"]) fs.mkdirSync(path.join(DATA, dir), { recursive: true });
if (!fs.existsSync(path.join(DATA, "costs.toml"))) fs.copyFileSync(path.join(APP_ROOT, "costs.toml"), path.join(DATA, "costs.toml"));
for (const f of fs.readdirSync(path.join(APP_ROOT, "profiles")).filter((f) => f.endsWith(".json")))
  if (!fs.existsSync(path.join(DATA, "profiles", f))) fs.copyFileSync(path.join(APP_ROOT, "profiles", f), path.join(DATA, "profiles", f));
fs.mkdirSync(CACHE, { recursive: true });
