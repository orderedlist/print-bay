// Git for the library and the app's own code: what changed, commit, push.
// In a checkout that is its own library (see config.ts) the two are one repo.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { APP_ROOT, DATA, GIT } from "./config.js";

export interface RepoChange { path: string; status: "added" | "modified" | "deleted" | "renamed" | "conflict" }
export interface Repo {
  id: "library" | "app";
  name: string;
  path: string;
  branch: string | null; // null: detached
  remote: string | null; // origin's URL
  upstream: string | null; // the tracking branch, once pushed
  ahead: number;
  behind: number; // as of the last fetch or pull
  lastCommit: { hash: string; subject: string; at: number } | null;
  changes: RepoChange[];
  suggestion: string; // a commit message for these changes
}

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Never wait on a password or passphrase prompt: there's no terminal to type it in.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
};

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, env: ENV, timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      const out = (stderr || err?.message || "").trim();
      if (err) reject(Object.assign(fail(out.split("\n").filter((l) => !l.startsWith("hint:")).slice(-4).join("\n"), 500), { output: out }));
      else resolve(stdout);
    });
  });
}

const toplevel = (dir: string) => git(dir, ["rev-parse", "--show-toplevel"]).then((s) => fs.realpathSync(s.trim()), () => null);

/** A new library becomes its own repo, ignoring slices and the cache. */
export async function ensureLibraryRepo(): Promise<void> {
  if (await toplevel(DATA)) return;
  await git(DATA, ["init", "-b", "main"]);
  const ignore = path.join(DATA, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "gcode/\n.cache/\n.DS_Store\n");
  await git(DATA, ["add", "-A"]);
  // needs a git identity (user.name, user.email); without one the first commit waits for the user
  await git(DATA, ["commit", "-m", "Start the Print Bay library"]).catch(() => {});
}

async function roots(): Promise<{ id: Repo["id"]; name: string; dir: string }[]> {
  const [lib, app] = await Promise.all([toplevel(DATA), toplevel(APP_ROOT)]);
  if (lib && lib === app) return [{ id: "library", name: "Library and app", dir: lib }];
  return [
    ...(lib ? [{ id: "library" as const, name: "Library", dir: lib }] : []),
    ...(app ? [{ id: "app" as const, name: "Print Bay app", dir: app }] : []),
  ];
}

async function dirFor(id: string): Promise<string> {
  const hit = (await roots()).find((r) => r.id === id);
  if (!hit) throw fail("No such repository", 404);
  return hit.dir;
}

const STATUS: Record<string, RepoChange["status"]> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed", C: "added" };

/** `git status --porcelain=v2 --branch`: branch headers, then one line per changed path. */
function parseStatus(out: string) {
  let branch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
  const changes: RepoChange[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const f = line.split(" ");
    if (line.startsWith("# branch.head ")) branch = f[2] === "(detached)" ? null : f[2];
    else if (line.startsWith("# branch.upstream ")) upstream = f[2];
    else if (line.startsWith("# branch.ab ")) { ahead = Number(f[2]); behind = -Number(f[3]); }
    else if (f[0] === "?") changes.push({ path: f.slice(1).join(" "), status: "added" });
    else if (f[0] === "u") changes.push({ path: f.slice(10).join(" "), status: "conflict" });
    else if (f[0] === "1" || f[0] === "2") {
      const xy = f[1].replace(/\./g, "");
      const rest = f.slice(f[0] === "1" ? 8 : 9).join(" ");
      changes.push({ path: rest.split("\t")[0], status: STATUS[xy[0]] ?? "modified" });
    }
  }
  return { branch, upstream, ahead, behind, changes };
}

/** "Update tote-rack", "Add shelf bracket, update tote-rack", or the files when it isn't models. */
function suggest(changes: RepoChange[]): string {
  if (!changes.length) return "";
  const models = new Map<string, Set<RepoChange["status"]>>();
  const other: string[] = [];
  for (const c of changes) {
    const m = c.path.match(/^(?:models|jobs)\/([^/]+?)(?:\.toml)?(?:\/|$)/);
    if (m) { const s = models.get(m[1]) ?? new Set(); s.add(c.status); models.set(m[1], s); }
    else other.push(path.basename(c.path));
  }
  const verb = (s: Set<RepoChange["status"]>) => (s.size === 1 && s.has("added") ? "Add" : s.size === 1 && s.has("deleted") ? "Remove" : "Update");
  const groups = new Map<string, string[]>();
  for (const [id, s] of models) groups.set(verb(s), [...(groups.get(verb(s)) ?? []), id]);
  if (other.length) groups.set("Update", [...(groups.get("Update") ?? []), ...new Set(other)]);
  const parts = [...groups].map(([v, names]) => `${v} ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`);
  const msg = parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join("; ");
  return msg;
}

export async function listRepos(): Promise<Repo[]> {
  return Promise.all((await roots()).map(async ({ id, name, dir }) => {
    const [status, remote, last] = await Promise.all([
      git(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
      git(dir, ["remote", "get-url", "origin"]).then((s) => s.trim(), () => null),
      git(dir, ["log", "-1", "--format=%h%x09%ct%x09%s"]).then((s) => s.trim(), () => ""),
    ]);
    const s = parseStatus(status);
    const [hash, at, ...subject] = last.split("\t");
    return {
      id, name, path: dir, remote, ...s,
      lastCommit: hash ? { hash, subject: subject.join("\t"), at: Number(at) * 1000 } : null,
      suggestion: suggest(s.changes),
    };
  }));
}

/** Commit everything that changed (git add -A): what the app shows is what goes in. */
export async function commit(id: string, message: string): Promise<Repo[]> {
  const dir = await dirFor(id);
  const msg = message.trim();
  if (!msg) throw fail("Write a commit message");
  await git(dir, ["add", "-A"]);
  try {
    await git(dir, ["commit", "-m", msg]);
  } catch (e) {
    const text = (e as { output?: string }).output ?? "";
    if (/tell me who you are|user\.email|user\.name/i.test(text))
      throw fail("Git doesn't know who you are yet. Set user.name and user.email (git config --global) and try again.");
    throw e;
  }
  return listRepos();
}

export async function push(id: string): Promise<Repo[]> {
  const dir = await dirFor(id);
  const repo = (await listRepos()).find((r) => r.id === id)!;
  if (!repo.remote) throw fail("Add a remote to push to first");
  if (!repo.branch) throw fail("Not on a branch (detached HEAD); check one out first");
  try {
    // the first push sets the upstream so later ones (and ahead/behind) know where to go
    await git(dir, repo.upstream ? ["push"] : ["push", "-u", "origin", repo.branch], 120_000);
  } catch (e) {
    const text = (e as { output?: string }).output ?? "";
    if (/rejected|non-fast-forward|fetch first/i.test(text)) throw fail("The remote has commits this copy doesn't. Pull them in a terminal (git pull), then push.");
    if (/terminal prompts disabled|could not read Username|Permission denied|publickey|Authentication failed/i.test(text))
      throw fail(`Git couldn't sign in to ${repo.remote}. Push once from a terminal (or set up an SSH key or credential helper), then try again.`);
    throw e;
  }
  return listRepos();
}

// https://host/path, ssh://..., git@host:path, or a local folder (absolute path)
const REMOTE = /^(https?:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+|\/[^\s]*)$/;

export async function setRemote(id: string, url: string): Promise<Repo[]> {
  const dir = await dirFor(id);
  const u = url.trim();
  if (!REMOTE.test(u)) throw fail("Use an https:// or git@host:path URL");
  const has = await git(dir, ["remote", "get-url", "origin"]).then(() => true, () => false);
  await git(dir, has ? ["remote", "set-url", "origin", u] : ["remote", "add", "origin", u]);
  return listRepos();
}
