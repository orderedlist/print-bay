// Meshes are big (a cookie cutter with round corners is 20 MB of STL) but squeeze well, often 10x,
// which matters to a phone over Tailscale. Each file is gzipped once, kept in the cache, and
// redone when the file changes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { CACHE } from "./config.js";

const DIR = path.join(CACHE, "gz");
const inflight = new Map<string, Promise<string>>();

/** A gzipped copy of `file`, made once per change to it. */
export function gzipped(file: string): Promise<string> {
  const dest = path.join(DIR, crypto.createHash("sha1").update(file).digest("hex") + ".gz");
  const made = fs.statSync(dest, { throwIfNoEntry: false });
  if (made && made.mtimeMs >= fs.statSync(file).mtimeMs) return Promise.resolve(dest);
  if (!inflight.has(dest)) {
    inflight.set(dest, (async () => {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 4 }), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return dest;
    })().finally(() => inflight.delete(dest)));
  }
  return inflight.get(dest)!;
}
