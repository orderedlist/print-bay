import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// app/server/{src,dist}/config.* -> repo root
const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.PRINT_BAY_ROOT ?? path.resolve(here, "../../..");
export const CACHE = process.env.PRINT_BAY_CACHE ?? path.join(ROOT, ".cache", "app");
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
export const PYTHON = process.env.PYTHON ?? firstExisting(path.join(ROOT, ".venv/bin/python"), "python3");

fs.mkdirSync(CACHE, { recursive: true });
