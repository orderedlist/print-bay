// Stage what the packaged app carries in build/printbay, laid out like the repo so the
// server's paths work unchanged (APP_ROOT = Contents/Resources/printbay):
//   app/server/dist/{index,check-cli,check-worker,slice-cli}.js   the server, the checks CLI and worker, the slicer
//   app/web/dist/                           the built UI
//   scripts/{check,nurb,nurb_part.py}       Claude's tools and the nurb builder
//   profiles/*.json, costs.toml             what a new library starts with
// No models, jobs or slices: those live in each user's library.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out = path.join(here, "build", "printbay");

fs.rmSync(out, { recursive: true, force: true });

// ESM output still needs require() and __dirname for the CommonJS packages it pulls in (fastify).
const banner = [
  'import { createRequire as __pbRequire } from "node:module";',
  'import { fileURLToPath as __pbPath } from "node:url";',
  'import { dirname as __pbDir } from "node:path";',
  "const require = __pbRequire(import.meta.url);",
  "const __filename = __pbPath(import.meta.url);",
  "const __dirname = __pbDir(__filename);",
].join("\n");

await build({
  entryPoints: {
    index: path.join(repo, "app/server/src/index.ts"),
    "check-cli": path.join(repo, "app/server/src/check-cli.ts"),
    "check-worker": path.join(repo, "app/server/src/check-worker.ts"), // modelchecks.ts runs the checks in it
    "slice-cli": path.join(repo, "app/server/src/slice-cli.ts"), // slice.ts runs each slice as its own process
  },
  outdir: path.join(out, "app/server/dist"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outExtension: { ".js": ".js" },
  banner: { js: banner },
  logLevel: "warning",
});
fs.writeFileSync(path.join(out, "app/server/package.json"), '{ "type": "module" }\n');

const web = path.join(repo, "app/web/dist");
if (!fs.existsSync(path.join(web, "index.html"))) throw new Error("Build the web UI first (npm run build in app/)");
fs.cpSync(web, path.join(out, "app/web/dist"), { recursive: true });

fs.mkdirSync(path.join(out, "scripts"), { recursive: true });
for (const f of ["check", "nurb", "nurb_part.py"]) fs.copyFileSync(path.join(repo, "scripts", f), path.join(out, "scripts", f));
for (const f of ["check", "nurb"]) fs.chmodSync(path.join(out, "scripts", f), 0o755);

fs.mkdirSync(path.join(out, "profiles"), { recursive: true });
for (const f of fs.readdirSync(path.join(repo, "profiles")).filter((f) => f.endsWith(".json")))
  fs.copyFileSync(path.join(repo, "profiles", f), path.join(out, "profiles", f));
fs.copyFileSync(path.join(repo, "costs.toml"), path.join(out, "costs.toml"));

console.log(`Staged ${path.relative(repo, out)}`);
