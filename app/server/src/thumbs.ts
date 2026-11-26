// Model list previews, kept as images. A browser draws a preview from the model's mesh, which can
// run to tens of megabytes, then hands the picture back here. Every later visit, a phone over
// Tailscale included, loads that small image instead of downloading the mesh. The browser names
// each picture by a hash of everything that changes how it looks, so a stale one is never served.
import fs from "node:fs";
import path from "node:path";
import { CACHE } from "./config.js";
import { getModel } from "./jobs.js";

const DIR = path.join(CACHE, "thumbs");
const TYPES: Record<string, string> = { "image/png": "png", "image/webp": "webp" };
const HASH = /^[a-z0-9]{1,32}$/;

function check(modelId: string, hash: string) {
  getModel(modelId); // 404s for a model that isn't there, so ids can't reach outside the folder
  if (!HASH.test(hash)) throw Object.assign(new Error("Bad preview name"), { statusCode: 400 });
}

/** The saved preview for this model and hash, or null. */
export function findThumb(modelId: string, hash: string): { file: string; type: string } | null {
  check(modelId, hash);
  for (const [type, ext] of Object.entries(TYPES)) {
    const file = path.join(DIR, `${modelId}.${hash}.${ext}`);
    if (fs.existsSync(file)) return { file, type };
  }
  return null;
}

/** Keep a browser-drawn preview, replacing the model's older ones. */
export function saveThumb(modelId: string, hash: string, type: string, body: Buffer) {
  check(modelId, hash);
  const ext = TYPES[type];
  if (!ext || !Buffer.isBuffer(body) || !body.length) throw Object.assign(new Error("Expected a PNG or WebP image"), { statusCode: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of fs.readdirSync(DIR))
    if (name.startsWith(`${modelId}.`) && name.split(".").length === 3) fs.rmSync(path.join(DIR, name), { force: true });
  const file = path.join(DIR, `${modelId}.${hash}.${ext}`);
  fs.writeFileSync(file + ".tmp", body);
  fs.renameSync(file + ".tmp", file);
}
