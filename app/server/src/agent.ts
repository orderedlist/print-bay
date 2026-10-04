// Claude agents that edit or create models, one `claude -p` run per chat turn.
//
// Scope is enforced by the CLI, not by trusting the prompt: every run uses
// `--permission-mode dontAsk`, so any tool call outside the allow list is denied.
// Each turn snapshots the files it may touch so it can be undone.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CACHE, CLAUDE, OPENSCAD, ROOT } from "./config.js";
import { publish } from "./events.js";
import { listJobs } from "./jobs.js";
import { checkModel } from "./modelchecks.js";

export type Entry =
  | { role: "user"; text: string; uploads: string[] }
  | { role: "assistant"; text: string }
  | { role: "tool"; label: string; ok: boolean | null; id: string }
  | { role: "note"; text: string; error?: boolean };

export interface AgentSession {
  id: string;
  kind: "edit" | "new";
  modelId: string | null;
  job: string | null;
  claudeSessionId: string | null;
  transcript: Entry[];
  running: boolean;
  turns: number;
  cost: number;
  createdAt: number;
}

const DIR = path.join(CACHE, "agent");
fs.mkdirSync(DIR, { recursive: true });
const sessions = new Map<string, AgentSession>();
const children = new Map<string, ChildProcess>();
const stopping = new Set<string>(); // sessions the user stopped: not an error

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function sessionDir(id: string) {
  return path.join(DIR, id);
}

/** Where a chat's throwaway files go (test renders, previews): the CLI denies anything outside its directories. */
function scratchDir(id: string) {
  return path.join(sessionDir(id), "scratch");
}

function save(s: AgentSession) {
  fs.writeFileSync(path.join(DIR, `${s.id}.json`), JSON.stringify({ ...s, running: false }, null, 2));
}

let pending: NodeJS.Timeout | null = null;
const dirty = new Set<string>();
/** Push session state to browsers, coalescing bursts of text deltas. */
function emit(s: AgentSession, now = false) {
  dirty.add(s.id);
  const flush = () => {
    pending = null;
    for (const id of dirty) { const x = sessions.get(id); if (x) publish("agent", x); }
    dirty.clear();
  };
  if (now) { if (pending) clearTimeout(pending); flush(); }
  else pending ??= setTimeout(flush, 80);
}

export function getSession(id: string): AgentSession {
  let s = sessions.get(id);
  if (!s) {
    const file = path.join(DIR, `${id}.json`);
    if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) throw fail("No such session", 404);
    s = JSON.parse(fs.readFileSync(file, "utf8")) as AgentSession;
    sessions.set(id, s);
  }
  return s;
}

/** The most recent edit session for a model, if any. */
export function latestFor(modelId: string): AgentSession | null {
  const all = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))
    .map((f) => getSession(f.slice(0, -5)))
    .filter((s) => s.modelId === modelId) // edits, and the chat that created it
    .sort((a, b) => b.createdAt - a.createdAt);
  return all[0] ?? null;
}

function jobFor(modelId: string) {
  return listJobs().find((j) => j.model.startsWith(`models/${modelId}/`))?.name ?? null;
}

export function createSession(kind: "edit" | "new", modelId?: string): AgentSession {
  if (kind === "edit") {
    if (!modelId || !fs.existsSync(path.join(ROOT, "models", modelId))) throw fail("No such model", 404);
  }
  const s: AgentSession = {
    id: randomUUID(), kind, modelId: kind === "edit" ? modelId! : null, job: kind === "edit" ? jobFor(modelId!) : null,
    claudeSessionId: null, transcript: [], running: false, turns: 0, cost: 0, createdAt: Date.now(),
  };
  sessions.set(s.id, s);
  save(s);
  return s;
}

// ---- uploads ----

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/svg+xml": ".svg",
};

export function saveUpload(id: string, type: string, body: Buffer): string {
  getSession(id);
  const ext = IMAGE_TYPES[type];
  if (!ext) throw fail("Photos (JPEG, PNG, WebP, GIF, HEIC) or SVG drawings only");
  const dir = path.join(sessionDir(id), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
  fs.writeFileSync(path.join(dir, name), body);
  return name;
}

export function uploadPath(id: string, name: string) {
  if (!/^[\w.-]+$/.test(name)) throw fail("Bad file name");
  const file = path.join(sessionDir(id), "uploads", name);
  if (!fs.existsSync(file)) throw fail("No such upload", 404);
  return file;
}

// ---- snapshots for undo ----

function scopePaths(s: AgentSession): string[] {
  if (!s.modelId) return [];
  const paths = [`models/${s.modelId}`];
  const job = s.job ?? (s.kind === "new" ? s.modelId : null); // a new model's job is named after it
  if (job) paths.push(`jobs/${job}.toml`);
  return paths;
}

// ---- naming a new model ----

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A short name for what the user asked for: Claude (Haiku) if it answers quickly, else the first few words. */
function nameFor(request: string): Promise<string> {
  const fallback = () => {
    const words = request.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w && !/^(a|an|the|i|my|me|for|to|of|that|with|and|need|want|make|please|can|you|some|it)$/i.test(w));
    return words.slice(0, 3).join(" ") || "New Model";
  };
  return new Promise((done) => {
    const prompt = `Name this 3D-printable part in 2 to 4 words, Title Case, no punctuation, no quotes. Reply with the name only.\n\nRequest: ${request.slice(0, 600)}`;
    const child = spawn(CLAUDE, ["-p", prompt, "--model", "haiku", "--permission-mode", "dontAsk"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
    child.stdout!.on("data", (c: Buffer) => { out += c.toString(); });
    const finish = () => {
      clearTimeout(timer);
      const name = out.trim().split("\n")[0].replace(/["'`*.]/g, "").trim();
      done(name && name.length <= 48 && slugify(name) ? name : fallback());
    };
    child.on("close", finish);
    child.on("error", () => { clearTimeout(timer); done(fallback()); });
  });
}

/** A folder name for a new model that isn't taken. */
function freeSlug(name: string): string {
  const base = slugify(name) || "new-model";
  let slug = base;
  for (let n = 2; fs.existsSync(path.join(ROOT, "models", slug)) || fs.existsSync(path.join(ROOT, "jobs", `${slug}.toml`)); n++) slug = `${base}-${n}`;
  return slug;
}

function snapshot(s: AgentSession, turn: number) {
  const dir = path.join(sessionDir(s.id), `turn-${turn}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const manifest: { path: string; existed: boolean }[] = [];
  for (const rel of scopePaths(s)) {
    const src = path.join(ROOT, rel);
    const existed = fs.existsSync(src);
    if (existed) fs.cpSync(src, path.join(dir, "files", rel), { recursive: true, preserveTimestamps: true });
    manifest.push({ path: rel, existed });
  }
  const models = fs.readdirSync(path.join(ROOT, "models"));
  const jobs = fs.readdirSync(path.join(ROOT, "jobs"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest, models, jobs }));
}

export function undo(id: string): AgentSession {
  const s = getSession(id);
  if (s.running) throw fail("Wait for Claude to finish first", 409);
  if (!s.turns) throw fail("Nothing to undo", 409);
  const dir = path.join(sessionDir(s.id), `turn-${s.turns}`);
  const { manifest, models, jobs } = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const { path: rel, existed } of manifest as { path: string; existed: boolean }[]) {
    const dest = path.join(ROOT, rel);
    fs.rmSync(dest, { recursive: true, force: true });
    // keep the old mtimes so an undone model matches its old slice again
    if (existed) fs.cpSync(path.join(dir, "files", rel), dest, { recursive: true, preserveTimestamps: true });
  }
  // a new-model turn may have created the model: remove what it added
  for (const m of fs.readdirSync(path.join(ROOT, "models"))) if (!models.includes(m)) fs.rmSync(path.join(ROOT, "models", m), { recursive: true, force: true });
  for (const j of fs.readdirSync(path.join(ROOT, "jobs"))) if (!jobs.includes(j)) fs.rmSync(path.join(ROOT, "jobs", j), { force: true });
  if (s.kind === "new" && !fs.existsSync(path.join(ROOT, "models", s.modelId ?? "-"))) { s.modelId = null; s.job = null; }
  s.turns--;
  s.transcript.push({ role: "note", text: "Undid the last change." });
  save(s);
  emit(s, true);
  publish("models", null);
  return s;
}

// ---- the brief ----

function brief(s: AgentSession): string {
  const common = `
You are working inside Print Bay, a local app for a Creality K2 3D printer (260 x 260 mm bed, PLA, 0.4 mm nozzle).
The user is chatting with you from the app's sidebar. Keep replies short and plain; they see your text and a list of your tool calls.
The repo is ${ROOT}. Models live in models/<slug>/, jobs (how to slice/print a model) in jobs/<slug>.toml.

OpenSCAD conventions (the app depends on these):
- Parameters first: top-level assignments whose value is only a number or "n * in" (with \`in = 25.4;\`), each with a // comment.
  The app shows exactly these as an editable form. Derived values come after and must reference parameters.
- Start each parameter's comment with an OpenSCAD customizer range so the app shows the right control:
  \`reach = 50; // [30:80] dowel centre out from the wall\` (a slider; [min:step:max] to set the step),
  \`rows = 3; // [1:6] bays up\` (whole numbers over a short range get a stepper),
  \`screw_dia = 4.5; // [3.4:M3, 4.5:M4 / #8, 5.5:M5] screw clearance\` (one button per choice).
  Pick ranges the part still works and prints across. Values in inches stay plain ("3.25 * in") with no range.
- Model the part upright (as used), then lay it out for printing at the end, like models/tote-rack/tote-rack.scad:
  an \`upright = false;\` flag and \`if (upright) part(); else <transform to print orientation> part();\`. The app renders with -D upright=true to show it.
- Design to print without supports where possible (45 degree rule, short bridges), within the 260 x 260 mm bed.
  Thin plate-like walls in 1.8 mm (two perimeters a side); keep solid members compact (the slicer prints them as shells).
- Multi-colour (the K2's CFS swaps filament within a layer, so colours print fused as ONE piece; never split a part
  for colour): add \`part = "all";\` and wrap each colour's geometry in \`if (part == "all" || part == "<name>")\`, laid out exactly
  where it sits in the finished part (an inlay fills its recess with no gap). List the parts in the job file in print order
  ([parts] then \`<name> = "<colour>"\` lines; filament 1, 2, ...): each layer starts with the first, so put a face-down inlay first. The app renders each part with -D part="<name>"
  and slices them as one object. Keep colour where it's seen: for a face inlay printed face down, one or two layers
  (0.2-0.4 mm) is enough and saves filament swaps.
- End with an echo of the overall size, e.g. echo(str("Size ", W, " x ", D, " x ", H, " mm")).
- Throwaway files (test renders, PNG previews, experiments) go in ${scratchDir(s.id)}/, never /tmp or anywhere else:
  only that folder and the model's own files are writable. Write files with the Write tool, not shell redirects.
- After every change, render to check it: ${OPENSCAD} -o ${scratchDir(s.id)}/check.stl <file>  (read the ECHO and any WARNING/ERROR).
  To look at it, render a PNG there (--imgsize=800,800 --camera=... --projection=o) and Read it.
- Then run the printability checks on the model as it will be sliced: node app/server/dist/check-cli.js <model-folder-name>
  (overhangs, thin walls, separate pieces, bed contact, warping, tipping, build volume). Fix FAILs; fix or explain WARNs.

Design rules for parts that print and hold up (FDM, PLA):
- Dimensions: never guess one the user can measure. Ask for all of them once, in one batch. Photos show shape and
  proportion, never sizes. Standards (screw sizes, dowel diameters) count as known. Note any assumed value as an assumption.
- Walls 2-3 mm for structure; thin plates 1.8 mm. Holes at least 2 mm. Horizontal holes as teardrops (45 degree top).
- Overhangs: nothing steeper than 45 degrees from vertical; carry ledges on a 45 degree underside. Bridges up to ~30 mm.
- Fits are extra clearance on the opening: press 0.1 mm, snug 0.2, moving 0.3 (minimum for anything that moves), free 0.5.
  Bores print small, so err loose. For a critical fit, suggest a small test coupon first.
- Fasteners: M3 clearance 3.4 mm, head 5.5 x 3; M4 clearance 4.5, head 7 x 4; #8 wood screw clearance 4.5 mm,
  countersink 9 mm. Hex nut pocket = across-corners + 0.2 (M3 6.1, M4 7.7). Don't model threads below M5; use nuts or
  heat-set inserts. A loaded screw hole needs wall at least the screw diameter around it.
- Strength: layers bond at about half the in-plane strength, so orient parts so the load doesn't peel layers apart.
  For anything cantilevered off a wall: reach/height up to 1.5 is fine; 1.5-2.5 add gussets (about half the reach deep);
  above 2.5 make the mount taller first. A second mount point beats a thicker part. Round inside corners at load junctions (~3 mm).
- Warping: a first layer over ~20,000 mm^2 gets rounded plan corners (8 mm radius or more).
- Finish: a 1 mm chamfer on exposed outside edges looks deliberate, but never on edges touching the bed or on mating faces.
  Keep proportions deliberate and symmetric by default; no text labels.
- In SOURCE.md keep short design notes, including what was tried and rejected (and why), so the next edit doesn't undo it.
You cannot slice, print, run git, or touch other files; the app slices when the user asks. Don't suggest commands for the user to run.`;

  // a nurb part (Python/build123d, models/<id>/parts/<part>.py) instead of OpenSCAD
  const nurbParts = s.modelId && fs.existsSync(path.join(ROOT, "models", s.modelId, "parts"))
    ? fs.readdirSync(path.join(ROOT, "models", s.modelId, "parts")).filter((f) => f.endsWith(".py")) : [];
  if (nurbParts.length) {
    const m = `models/${s.modelId}`;
    const part = nurbParts[0].slice(0, -3);
    return `${common}

THIS MODEL IS NOT OPENSCAD, so the OpenSCAD conventions above don't apply; the design rules do.
It is a nurb part: ${m}/parts/${part}.py, a Python function (build123d via \`from nurb import *\`) whose keyword defaults are
its parameters, each with a \`name: what it moves\` line in the docstring (the app shows those as the editable form). It takes
\`upright\` (False lays it out to print, True stands it as used) the same way the OpenSCAD models do. ${m}/parts/${part}.md is its
card: keep the design notes there current, never hand-edit the AUTO block. ${m}/measurements.toml records where each fitted
dimension came from.${s.job ? ` Its job file is jobs/${s.job}.toml (parameter overrides go in its [params] table).` : ""}
Change only files in ${m}/${s.job ? ` and jobs/${s.job}.toml` : ""}.
Tools, always through the wrapper (run from the repo root, one command per call):
- scripts/nurb ${m} rules                    the design doctrine; read it before a non-trivial change
- scripts/nurb ${m} api                      what \`from nurb import *\` provides, with signatures
- scripts/nurb ${m} check ${part}            the printability rules; fix what fails
- scripts/nurb ${m} inspect ${part}          measure the built part: faces, normals, which sit on the bed
- scripts/nurb ${m} stl ${part} ${scratchDir(s.id)}/check.stl [name=value ...]   build it, with overrides
nurb's printer line may name another printer; this one is the K2 (260 x 260 mm bed), so design to that.
Make the change the user asks for, keep the parameters editable, check it, then summarize what changed in a sentence or two
(mention new or changed parameters by name).`;
  }

  const drawn = s.modelId && fs.readdirSync(path.join(ROOT, "models", s.modelId)).some((f) => f.endsWith(".scad"));
  if (s.kind === "edit" || drawn) {
    return `${common}

You are editing the model in models/${s.modelId}/${s.job ? ` (its job file is jobs/${s.job}.toml)` : ""}. Change only those files.
Make the change the user asks for, keep the parameter block editable, render to verify, then summarize what changed in a sentence or two
(mention new or changed parameters by name).`;
  }
  return `${common}

You are creating a NEW model. The app already named it and made its folder, models/${s.modelId}/ (with a placeholder SOURCE.md);
the user sees it in their library. First, unless the request already pins it down, ask one short round of questions:
what it's for, what it must fit (key dimensions, in the user's units), and anything about mounting or strength. Use any photos for proportions,
and say what you're assuming. Then create:
- models/${s.modelId}/${s.modelId}.scad
- models/${s.modelId}/SOURCE.md     (replace the placeholder: "# <Title>", then bullets: what it is, key dimensions, "Designed in Print Bay with Claude")
- jobs/${s.modelId}.toml            copy the structure of jobs/tote-rack.toml (name, model, color = "black", copies = 1, [profiles], [presets],
                              [overrides.machine], [overrides.process]; enable_support = "0" unless it truly needs supports)
Render to verify, then tell the user it's ready and what they can tweak.`;
}

function allowedTools(s: AgentSession): string[] {
  const read = ["Read", "Glob", "Grep", `Bash(${OPENSCAD}:*)`, "Bash(openscad:*)",
    "Bash(node app/server/dist/check-cli.js:*)", `Bash(node ${ROOT}/app/server/dist/check-cli.js:*)`,
    "Bash(scripts/nurb:*)", `Bash(${ROOT}/scripts/nurb:*)`]; // nurb parts (see scripts/nurb)
  read.push(`Edit(/${scratchDir(s.id)}/**)`); // Edit rules cover Write too
  const m = `models/${s.modelId}`;
  if (s.kind === "edit") return [...read, `Edit(${m}/**)`, ...(s.job ? [`Edit(jobs/${s.job}.toml)`] : [])];
  return [...read, `Edit(${m}/**)`, `Edit(jobs/${s.modelId}.toml)`];
}

function toolLabel(name: string, input: any): string {
  const file = input?.file_path ? path.basename(input.file_path) : "";
  switch (name) {
    case "Read": return /\.(jpe?g|png|webp|gif|heic)$/i.test(file) ? "Looked at a photo" : /\.svg$/i.test(file) ? "Read the drawing" : `Read ${file}`;
    case "Edit": return `Edited ${file}`;
    case "Write": return `Wrote ${file}`;
    case "Glob": case "Grep": return "Searched the repo";
    case "Bash": return /openscad/.test(input?.command ?? "") ? "Rendered with OpenSCAD" : `Ran ${String(input?.command ?? "").split(" ")[0]}`;
    default: return name;
  }
}

// ---- running a turn ----

/** `shown` replaces the text in the transcript (for canned prompts like reviews). */
export function send(id: string, text: string, uploads: string[] = [], shown?: string): AgentSession {
  const s = getSession(id);
  if (s.running) throw fail("Claude is still working on the last message", 409);
  if (!text.trim() && !uploads.length) throw fail("Say what to change");
  const files = uploads.map((u) => uploadPath(s.id, u));

  s.turns++;
  s.transcript.push({ role: "user", text: shown ?? text, uploads });
  s.running = true;
  let prompt = text.trim() || "Here are some files.";
  const photos = files.filter((f) => !f.endsWith(".svg"));
  const svgs = files.filter((f) => f.endsWith(".svg"));
  if (photos.length) prompt += `\n\nPhotos from the user (read them): ${photos.join(", ")}`;

  if (s.kind === "new" && !s.modelId) {
    // name it and make its folder first, so the app can open it while Claude works
    s.transcript.push({ role: "note", text: "Naming it…" });
    emit(s, true);
    nameFor(text.trim() || "a part from photos").then((name) => {
      s.transcript = s.transcript.filter((e) => !(e.role === "note" && e.text === "Naming it…"));
      try {
        s.modelId = freeSlug(name);
        snapshot(s, s.turns); // before the folder exists, so undoing this turn removes it
        fs.mkdirSync(path.join(ROOT, "models", s.modelId));
        fs.writeFileSync(path.join(ROOT, "models", s.modelId, "SOURCE.md"), `# ${name}\n\n- Being designed in Print Bay with Claude.\n`);
      } catch (err) {
        s.modelId = null;
        s.turns--;
        s.running = false;
        s.transcript.push({ role: "note", error: true, text: `Couldn't create the model: ${(err as Error).message}` });
        save(s);
        emit(s, true);
        return;
      }
      emit(s, true);
      publish("models", null);
      run(s, prompt + attachSvgs(s, svgs));
    });
    return s;
  }
  snapshot(s, s.turns);
  emit(s, true);
  run(s, prompt + attachSvgs(s, svgs));
  return s;
}

/**
 * SVG drawings are copied into the model's folder (after the turn's snapshot, so undo
 * removes them), where OpenSCAD's import() can reach them by a relative path.
 */
function attachSvgs(s: AgentSession, svgs: string[]): string {
  if (!svgs.length || !s.modelId) return "";
  const names = svgs.map((file) => {
    const base = path.basename(file).replace(/^\d+-[0-9a-f]{8}/, "drawing");
    fs.copyFileSync(file, path.join(ROOT, "models", s.modelId!, base));
    return `models/${s.modelId}/${base}`;
  });
  return `\n\nSVG drawings from the user, copied into the model folder: ${names.join(", ")}
Read them for the shape. To use one as geometry, import it relative to the .scad, e.g. linear_extrude(h) import("${path.basename(names[0])}");
SVG units: OpenSCAD reads 1 px as 1 mm unless the file sets a width/height in mm; check the size with an echo or a render and scale to the dimensions the user gave.`;
}

/** One `claude -p` turn, streaming into the transcript. */
function run(s: AgentSession, prompt: string) {
  fs.mkdirSync(scratchDir(s.id), { recursive: true });
  const args = [
    "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "dontAsk", "--add-dir", scratchDir(s.id), "--allowedTools", ...allowedTools(s),
    "--append-system-prompt", brief(s),
  ];
  if (s.claudeSessionId) args.push("--resume", s.claudeSessionId);
  const child = spawn(CLAUDE, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.set(s.id, child);

  let streaming: Extract<Entry, { role: "assistant" }> | null = null;
  const tools = new Map<string, Extract<Entry, { role: "tool" }>>();
  let stderr = "";
  let buffer = "";
  let resultSeen = false;

  const handle = (e: any) => {
    if (e.type === "system" && e.subtype === "init") s.claudeSessionId = e.session_id;
    else if (e.type === "stream_event") {
      const ev = e.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
        streaming = { role: "assistant", text: "" };
        s.transcript.push(streaming);
      } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && streaming) {
        streaming.text += ev.delta.text;
        emit(s);
      } else if (ev?.type === "content_block_stop") streaming = null;
    } else if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_use" && !tools.has(b.id)) {
          const entry = { role: "tool" as const, label: toolLabel(b.name, b.input), ok: null, id: b.id };
          tools.set(b.id, entry);
          s.transcript.push(entry);
        }
      }
      emit(s);
    } else if (e.type === "user") {
      for (const b of e.message?.content ?? []) {
        if (b?.type === "tool_result" && tools.has(b.tool_use_id)) tools.get(b.tool_use_id)!.ok = !b.is_error;
      }
      emit(s);
    } else if (e.type === "result") {
      resultSeen = true;
      s.cost += e.total_cost_usd ?? 0;
      if (e.is_error && !stopping.has(s.id)) s.transcript.push({ role: "note", text: String(e.result ?? "Claude stopped with an error."), error: true });
    }
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* not JSON: ignore */ }
    }
  });
  child.stderr!.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-2000); });
  const finish = (note?: Entry) => {
    if (!s.running) return;
    children.delete(s.id);
    if (stopping.delete(s.id)) note = { role: "note", text: "Stopped." };
    s.running = false;
    if (note) s.transcript.push(note);
    if (s.modelId && !s.job) s.job = jobFor(s.modelId);
    save(s);
    emit(s, true);
    publish("models", null);
  };
  child.on("error", (err) => finish({ role: "note", error: true,
    text: `Couldn't start Claude Code (${CLAUDE}): ${err.message}. Install it or set CLAUDE to its path.` }));
  child.on("close", (code, signal) => {
    if (signal) return finish({ role: "note", text: "Stopped." });
    if (code !== 0 && !resultSeen) {
      const hint = /log ?in|auth|credential/i.test(stderr) ? " Run `claude` once in a terminal to sign in." : "";
      return finish({ role: "note", error: true, text: `Claude exited with code ${code}.${hint}\n${stderr.trim().split("\n").slice(-4).join("\n")}` });
    }
    finish();
  });
}

/**
 * "Analyze and correct": a code-review style pass over the model. The rules come
 * from the brief, so improvements to it apply here automatically; the current
 * check results are included so the review starts from facts.
 */
export async function review(id: string): Promise<AgentSession> {
  const s = getSession(id);
  if (!s.modelId) throw fail("Reviews run on an existing model", 400);
  let findings = "Couldn't run the checks; run them yourself first.";
  try {
    const r = await checkModel(s.modelId);
    findings = r.findings.length
      ? r.findings.map((f) => `- ${f.severity.toUpperCase()} ${f.rule}: ${f.message} (${f.detail})`).join("\n")
      : "- No findings.";
  } catch { /* the agent runs them itself */ }
  const prompt = `Analyze and correct this model, like a code review.

Current printability checks (as it will be sliced):
${findings}

1. Read the .scad, SOURCE.md and the job file. Review the design against every rule in your instructions:
   dimensions and assumptions, walls, overhangs and bridges, holes (teardrops when horizontal), fits, fasteners,
   strength and load path, warping, print orientation, finish, and whether the parameters stay editable.
2. Reply first with a short review: **Must fix**, **Should fix**, **Fine as is**, one line each, naming the rule.
3. Fix the must-fix and should-fix items. Don't change measured dimensions or what the part is for; if a fix
   needs my decision, ask instead of guessing.
4. Re-render and re-run the checks until they're clean, or explain any finding you're leaving.
5. Summarize what changed and what's left, and add a dated "Review" note to SOURCE.md.`;
  return send(id, prompt, [], "Analyze and correct");
}

export function stop(id: string) {
  const child = children.get(id);
  if (child) { stopping.add(id); child.kill("SIGTERM"); }
  return getSession(id);
}
