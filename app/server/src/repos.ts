// Git for the library and the app's own code: what changed, commit, push.
// In a checkout that is its own library (see config.ts) the two are one repo.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { anyRunning } from "./agent.js";
import { APP_ROOT, DATA, GIT, seedLibrary } from "./config.js";

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

/** Resolves with stdout; a failure's `output` holds everything git said, for matching. */
function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return gitBoth(cwd, args, timeout).then((r) => r.stdout);
}

function gitBoth(cwd: string, args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, env: ENV, timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      const said = (stderr || err.message).trim();
      reject(Object.assign(fail(said.split("\n").filter((l) => !l.startsWith("hint:")).slice(-4).join("\n"), 500),
        { output: `${stdout}\n${said}` }));
    });
  });
}

const SIGN_IN = /terminal prompts disabled|could not read Username|Permission denied|publickey|Authentication failed/i;
const signInFailed = (remote: string | null) =>
  fail(`Git couldn't sign in to ${remote}. Push once from a terminal (or set up an SSH key or credential helper), then try again.`);
const waitForClaude = () => { if (anyRunning()) throw fail("Wait for Claude to finish editing first", 409); };

const toplevel = (dir: string) => git(dir, ["rev-parse", "--show-toplevel"]).then((s) => fs.realpathSync(s.trim()), () => null);

/**
 * What the library repo never commits, whatever its .gitignore says (one cloned from
 * elsewhere may not have one): this computer's settings, slices and the cache.
 */
const NEVER = ["settings.json", "gcode/", ".cache/"];
async function excludeLocalFiles(): Promise<void> {
  const top = await toplevel(DATA);
  if (!top) return;
  const rel = path.relative(top, DATA);
  const file = path.resolve(top, (await git(DATA, ["rev-parse", "--git-path", "info/exclude"])).trim());
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = NEVER.map((p) => "/" + path.posix.join(rel.split(path.sep).join("/"), p)).filter((p) => !have.split("\n").includes(p));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}# Print Bay: this computer's files\n${missing.join("\n")}\n`);
}

/** A new library becomes its own repo, ignoring slices and the cache. */
export async function ensureLibraryRepo(): Promise<void> {
  if (await toplevel(DATA)) return excludeLocalFiles();
  await git(DATA, ["init", "-b", "main"]);
  await excludeLocalFiles();
  const ignore = path.join(DATA, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "gcode/\n.cache/\n.DS_Store\n");
  await git(DATA, ["add", "-A"]);
  // needs a git identity (user.name, user.email); without one the first commit waits for the user
  await git(DATA, ["commit", "-m", "Start the Print Bay library"]).catch(() => {});
}

async function roots(): Promise<{ id: Repo["id"]; name: string; dir: string }[]> {
  // a packaged app's code is read-only and not a checkout, wherever the .app happens to sit
  const [lib, app] = await Promise.all([toplevel(DATA), process.env.PRINT_BAY_PACKAGED ? null : toplevel(APP_ROOT)]);
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
    const m = c.path.match(/^(?:models|jobs|plates)\/([^/]+?)(?:\.toml)?(?:\/|$)/);
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

// Fetching keeps "to pull" honest; at most once a minute per repo, and never an error.
const fetchedAt = new Map<string, number>();
export async function fetchAll(): Promise<void> {
  await Promise.all((await roots()).map(async ({ dir }) => {
    if (Date.now() - (fetchedAt.get(dir) ?? 0) < 60_000) return;
    fetchedAt.set(dir, Date.now());
    const remote = await git(dir, ["remote"]).then((s) => s.trim(), () => "");
    if (remote) await git(dir, ["fetch", "--quiet", "--prune"], 20_000).catch(() => {});
  }));
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
  waitForClaude();
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
    if (/rejected|non-fast-forward|fetch first/i.test(text)) throw fail("The remote has commits this copy doesn't. Pull them first, then push.");
    if (SIGN_IN.test(text)) throw signInFailed(repo.remote);
    throw e;
  }
  return listRepos();
}

export interface PullResult {
  repos: Repo[];
  pulled: number; // commits that came in
  appChanged: boolean; // the app's code changed: rebuild and restart to use it
  stashConflict: boolean; // uncommitted edits didn't reapply cleanly; they're kept in git's stash
}

/**
 * Bring in the remote's commits: rebase local commits on top (a straight line of history),
 * with uncommitted edits set aside and put back. If anything conflicts, nothing changes.
 */
export async function pull(id: string): Promise<PullResult> {
  waitForClaude();
  const dir = await dirFor(id);
  const repo = (await listRepos()).find((r) => r.id === id)!;
  if (!repo.remote) throw fail("Add a remote to pull from first");
  if (!repo.upstream) throw fail("Push once first, so this branch knows where to pull from");
  const before = (await git(dir, ["rev-parse", "HEAD"])).trim();
  // Uncommitted edits to a file the pull changes would come back as conflict markers in it: refuse first.
  try { await git(dir, ["fetch", "--quiet"], 60_000); } catch (e) {
    if (SIGN_IN.test((e as { output?: string }).output ?? "")) throw signInFailed(repo.remote);
    throw e;
  }
  const incoming = new Set((await git(dir, ["diff", "--name-only", "HEAD...@{u}"])).split("\n").filter(Boolean));
  const clash = repo.changes.map((c) => c.path).filter((p) => incoming.has(p));
  if (clash.length)
    throw fail(`The pull changes ${clash.slice(0, 3).join(", ")}${clash.length > 3 ? ` and ${clash.length - 3} more` : ""}, which you've edited. Commit first, then pull.`, 409);
  let said = "";
  try {
    const r = await gitBoth(dir, ["pull", "--rebase", "--autostash"], 120_000);
    said = r.stdout + r.stderr;
  } catch (e) {
    const text = (e as { output?: string }).output ?? "";
    if (/CONFLICT|could not apply|Resolve all conflicts/i.test(text)) {
      await git(dir, ["rebase", "--abort"]).catch(() => {}); // back to exactly where we were, edits included
      const files = [...text.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/g)].map((m) => m[1]);
      throw fail(`Your commits and the remote's both change ${files.length ? files.slice(0, 3).join(", ") : "the same files"}. Nothing was pulled; merge them in a terminal.`, 409);
    }
    if (SIGN_IN.test(text)) throw signInFailed(repo.remote);
    throw e;
  }
  fetchedAt.set(dir, Date.now());
  const pulled = Number((await git(dir, ["rev-list", "--count", `${before}..@{u}`])).trim());
  const changed = pulled ? (await git(dir, ["diff", "--name-only", before, "@{u}"])).split("\n").filter(Boolean) : [];
  return {
    repos: await listRepos(),
    pulled,
    appChanged: changed.some((p) => p.startsWith("app/")),
    stashConflict: /autostash resulted in conflicts|changes are safe in the stash/i.test(said),
  };
}

/**
 * Make a fresh library a copy of one on a remote (another computer's, or a shared one):
 * only while it has no models of its own, so nothing is lost.
 */
export async function startFromRemote(url: string, libraryFresh: boolean): Promise<Repo[]> {
  waitForClaude();
  const u = url.trim();
  if (!REMOTE.test(u)) throw fail("Use an https:// or git@host:path URL");
  if (!libraryFresh) throw fail("This library already has models. Start from a remote only in a new, empty library.", 409);
  const lib = (await roots()).find((r) => r.id === "library");
  if (!lib || path.resolve(lib.dir) !== fs.realpathSync(DATA)) throw fail("The library isn't its own repository", 409);
  const dir = lib.dir;
  const had = await git(dir, ["remote", "get-url", "origin"]).then(() => true, () => false);
  await git(dir, had ? ["remote", "set-url", "origin", u] : ["remote", "add", "origin", u]);
  try {
    await git(dir, ["fetch", "origin"], 180_000);
    // the remote's default branch: "ref: refs/heads/main\tHEAD"
    const head = await git(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
    const branch = head.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1];
    if (!branch) throw fail("That remote is empty. Push this library to it instead.", 409);
    await git(dir, ["checkout", "-f", "-B", branch, `origin/${branch}`]);
    await git(dir, ["branch", "-u", `origin/${branch}`]);
    await git(dir, ["clean", "-fdq", "--", "models", "jobs"]); // starter leftovers the remote doesn't have
  } catch (e) {
    if (!had) await git(dir, ["remote", "remove", "origin"]).catch(() => {});
    const text = (e as { output?: string }).output ?? "";
    if (SIGN_IN.test(text)) throw signInFailed(u);
    if (/not found|does not appear to be a git repository|Could not resolve host/i.test(text)) throw fail(`Couldn't find a repository at ${u}.`, 404);
    throw e;
  }
  seedLibrary(); // profiles or rates the remote's library doesn't have
  await excludeLocalFiles();
  fetchedAt.set(dir, Date.now());
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
