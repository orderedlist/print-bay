// electron-builder afterPack hook: give Print Bay's executables their own Mach-O UUIDs.
//
// macOS decides local network access (Privacy & Security > Local Network) by the executable's
// LC_UUID, not its bundle id. Every app built on the same Electron release ships the same stock
// executable, so the same UUID: macOS takes Print Bay for "com.github.Electron" (or whichever
// Electron app it met first with that UUID), never asks for Print Bay itself, and refuses its
// connections to the printers with EHOSTUNREACH. Each executable gets a UUID derived from the
// bundle id and its own name, the same every build, so a permission given once carries over to
// updates. This runs after packing and before signing, so the signature covers the change.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

/** 16 bytes from `seed`, marked as an RFC 9562 version 8 (custom) UUID. */
function uuidFrom(seed) {
  const b = crypto.createHash("sha256").update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

/** Overwrite the LC_UUID of the 64-bit Mach-O image at `offset` in `buf`. */
function patchImage(buf, offset, seed) {
  if (buf.readUInt32LE(offset) !== MH_MAGIC_64) throw new Error("not a 64-bit Mach-O image");
  const cputype = buf.readUInt32LE(offset + 4);
  const ncmds = buf.readUInt32LE(offset + 16);
  let cmd = offset + 32; // past the mach_header_64
  for (let i = 0; i < ncmds; i++) {
    if (buf.readUInt32LE(cmd) === LC_UUID) {
      uuidFrom(`${seed}|${cputype}`).copy(buf, cmd + 8);
      return;
    }
    cmd += buf.readUInt32LE(cmd + 4);
  }
  throw new Error("no LC_UUID load command");
}

/** Patch an executable: one image, or each image of a universal one. */
function patchFile(file, seed) {
  const buf = fs.readFileSync(file);
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const entry = magic === FAT_MAGIC ? 20 : 32;
    for (let i = 0; i < buf.readUInt32BE(4); i++) {
      const at = 8 + i * entry;
      patchImage(buf, magic === FAT_MAGIC ? buf.readUInt32BE(at + 8) : Number(buf.readBigUInt64BE(at + 8)), seed);
    }
  } else {
    patchImage(buf, 0, seed);
  }
  fs.writeFileSync(file, buf);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { productFilename, id } = context.packager.appInfo;
  const app = path.join(context.appOutDir, `${productFilename}.app`);
  const executables = [path.join(app, "Contents/MacOS", productFilename)];
  const frameworks = path.join(app, "Contents/Frameworks");
  for (const name of fs.readdirSync(frameworks)) // Print Bay Helper, (GPU), (Renderer), (Plugin)
    if (name.endsWith(".app") && name.includes(" Helper")) executables.push(path.join(frameworks, name, "Contents/MacOS", name.slice(0, -4)));
  for (const file of executables) patchFile(file, `${id}|${path.basename(file)}`);
  console.log(`  • gave ${executables.length} executables their own UUIDs (macOS Local Network privacy goes by it)`);
};
