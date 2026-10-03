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
    .filter((s) => s.kind === "edit" && s.modelId === modelId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return all[0] ?? null;
}

function jobFor(modelId: string) {
  return listJobs().find((j) => path.dirname(j.model) === `models/${modelId}`)?.name ?? null;
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

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic" };

export function saveUpload(id: string, type: string, body: Buffer): string {
  getSession(id);
  const ext = IMAGE_TYPES[type];
  if (!ext) throw fail("Photos only (JPEG, PNG, WebP, GIF, HEIC)");
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
  if (s.job) paths.push(`jobs/${s.job}.toml`);
  return paths;
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
- Model the part upright (as used), then lay it out for printing at the end, like models/tote-rack/tote-rack.scad:
  an \`upright = false;\` flag and \`if (upright) part(); else <transform to print orientation> part();\`. The app renders with -D upright=true to show it.
- Design to print without supports where possible (45 degree rule, short bridges), within the 260 x 260 mm bed.
  Thin plate-like walls in 1.8 mm (two perimeters a side); keep solid members compact (the slicer prints them as shells).
- End with an echo of the overall size, e.g. echo(str("Size ", W, " x ", D, " x ", H, " mm")).
- After every change, render to check it: ${OPENSCAD} -o /tmp/print-bay-check.stl <file>  (read the ECHO and any WARNING/ERROR).
You cannot slice, print, run git, or touch other files; the app slices when the user asks. Don't suggest commands for the user to run.`;

  if (s.kind === "edit") {
    return `${common}

You are editing the model in models/${s.modelId}/${s.job ? ` (its job file is jobs/${s.job}.toml)` : ""}. Change only those files.
Make the change the user asks for, keep the parameter block editable, render to verify, then summarize what changed in a sentence or two
(mention new or changed parameters by name).`;
  }
  return `${common}

You are creating a NEW model. First, unless the request already pins it down, ask one short round of questions:
what it's for, what it must fit (key dimensions, in the user's units), and anything about mounting or strength. Use any photos for proportions,
and say what you're assuming. Then create:
- models/<slug>/<slug>.scad   (slug: short, lowercase, hyphenated; must not already exist)
- models/<slug>/SOURCE.md     ("# <Title>", then bullets: what it is, key dimensions, "Designed in Print Bay with Claude")
- jobs/<slug>.toml            copy the structure of jobs/tote-rack.toml (name, model, color = "black", copies = 1, [profiles], [presets],
                              [overrides.machine], [overrides.process]; enable_support = "0" unless it truly needs supports)
Render to verify, then tell the user it's ready and what they can tweak.`;
}

function allowedTools(s: AgentSession): string[] {
  const read = ["Read", "Glob", "Grep", `Bash(${OPENSCAD}:*)`, "Bash(openscad:*)"];
  if (s.kind === "edit") {
    const m = `models/${s.modelId}`;
    return [...read, `Edit(${m}/**)`, `Write(${m}/**)`, ...(s.job ? [`Edit(jobs/${s.job}.toml)`] : [])];
  }
  return [...read, "Write(models/**)", "Edit(models/**)", "Write(jobs/**)", "Edit(jobs/**)", "Bash(mkdir:*)"];
}

function toolLabel(name: string, input: any): string {
  const file = input?.file_path ? path.basename(input.file_path) : "";
  switch (name) {
    case "Read": return /\.(jpe?g|png|webp|gif|heic)$/i.test(file) ? "Looked at a photo" : `Read ${file}`;
    case "Edit": return `Edited ${file}`;
    case "Write": return `Wrote ${file}`;
    case "Glob": case "Grep": return "Searched the repo";
    case "Bash": return /openscad/.test(input?.command ?? "") ? "Rendered with OpenSCAD" : `Ran ${String(input?.command ?? "").split(" ")[0]}`;
    default: return name;
  }
}

// ---- running a turn ----

export function send(id: string, text: string, uploads: string[] = []): AgentSession {
  const s = getSession(id);
  if (s.running) throw fail("Claude is still working on the last message", 409);
  if (!text.trim() && !uploads.length) throw fail("Say what to change");
  const files = uploads.map((u) => uploadPath(s.id, u));

  s.turns++;
  snapshot(s, s.turns);
  s.transcript.push({ role: "user", text, uploads });
  s.running = true;
  emit(s, true);

  let prompt = text.trim() || "Here are some photos.";
  if (files.length) prompt += `\n\nPhotos from the user (read them): ${files.join(", ")}`;
  const modelsBefore = new Set(fs.readdirSync(path.join(ROOT, "models")));

  const args = [
    "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "dontAsk", "--allowedTools", ...allowedTools(s),
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
    if (s.kind === "new" && !s.modelId) {
      const created = fs.readdirSync(path.join(ROOT, "models")).find((m) => !modelsBefore.has(m));
      if (created) { s.modelId = created; s.job = jobFor(created); }
    } else if (s.modelId && !s.job) s.job = jobFor(s.modelId);
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
  return s;
}

export function stop(id: string) {
  const child = children.get(id);
  if (child) { stopping.add(id); child.kill("SIGTERM"); }
  return getSession(id);
}
