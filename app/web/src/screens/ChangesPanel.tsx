import { useEffect, useState } from "react";
import { api } from "../api";
import type { Repo, RepoChange } from "../types";

interface Props {
  repos: Repo[];
  setRepos: (r: Repo[]) => void;
  toast: (msg: string, error?: boolean) => void;
}

const MARK: Record<RepoChange["status"], [string, string]> = {
  added: ["A", "var(--ok)"], modified: ["M", "var(--warn)"], deleted: ["D", "var(--bad)"], renamed: ["R", "var(--muted)"], conflict: ["!", "var(--bad)"],
};
const SHOWN = 14;

/** "github.com/steve/prints" from https://github.com/steve/prints.git or git@github.com:steve/prints.git */
const shortRemote = (url: string) => url.replace(/^(https?|ssh):\/\//, "").replace(/^[\w.-]+@/, "").replace(/:(?!\d)/, "/").replace(/\.git$/, "");

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

interface PullResult { repos: Repo[]; pulled: number; stashConflict: boolean }

/** Git for the library: what changed, commit it, pull and push it. */
export function ChangesPanel({ repos, setRepos, toast }: Props) {
  // fetch while this is open, so "to pull" is current (the server limits it to once a minute)
  useEffect(() => {
    const load = () => api<Repo[]>("/api/repos?fetch=1").then(setRepos).catch(() => {});
    load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, [setRepos]);
  if (!repos.length) return <div className="sec muted">The library isn't a git repository.</div>;
  return <>{repos.map((r) => <RepoSection key={r.id} repo={r} setRepos={setRepos} toast={toast} />)}</>;
}

function RepoSection({ repo, setRepos, toast }: { repo: Repo } & Omit<Props, "repos">) {
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState<"commit" | "pull" | "push" | "remote" | null>(null);
  const [all, setAll] = useState(false);

  const act = async (kind: "commit" | "push" | "remote", fn: () => Promise<Repo[]>, done: string) => {
    setBusy(kind);
    try { setRepos(await fn()); toast(done); if (kind === "commit") setMessage(""); if (kind === "remote") setRemote(""); }
    catch (e) { toast((e as Error).message, true); }
    setBusy(null);
  };
  const doCommit = () => act("commit",
    () => api<Repo[]>(`/api/repos/${repo.id}/commit`, { method: "POST", json: { message: message.trim() || repo.suggestion } }), "Committed.");
  const doPush = () => act("push", () => api<Repo[]>(`/api/repos/${repo.id}/push`, { method: "POST" }),
    `Pushed to ${repo.remote ? shortRemote(repo.remote) : "the remote"}.`);
  const doPull = async () => {
    setBusy("pull");
    try {
      const r = await api<PullResult>(`/api/repos/${repo.id}/pull`, { method: "POST" });
      setRepos(r.repos);
      if (r.stashConflict) toast("Pulled, but your uncommitted edits clash with it. They're kept in git's stash: run git stash pop in a terminal.", true);
      else toast(!r.pulled ? "Already up to date."
        : `Pulled ${r.pulled} ${r.pulled === 1 ? "commit" : "commits"}.`);
    } catch (e) { toast((e as Error).message, true); }
    setBusy(null);
  };
  const doRemote = () => act("remote", () => api<Repo[]>(`/api/repos/${repo.id}/remote`, { method: "PUT", json: { url: remote } }), "Remote saved.");

  const n = repo.changes.length;
  const shown = all ? repo.changes : repo.changes.slice(0, SHOWN);
  const unpushed = repo.lastCommit && (repo.upstream ? repo.ahead > 0 : true);
  const sync = !repo.remote ? "no remote"
    : !repo.lastCommit ? "nothing committed"
      : !repo.upstream ? "not pushed yet"
        : repo.ahead && repo.behind ? `${repo.ahead} to push, ${repo.behind} to pull`
          : repo.ahead ? `${repo.ahead} to push` : repo.behind ? `${repo.behind} to pull` : "up to date";

  return (
    <div className="sec">
      <div className="sech">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" /></svg>
        {repo.name}<span className="count">{n || ""}</span>
      </div>
      <div className="faint mono" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }} title={repo.path}>
        {repo.branch ?? "detached"}{repo.remote ? ` → ${shortRemote(repo.remote)}` : ""} · {sync}
      </div>
      {repo.lastCommit && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={`${repo.lastCommit.hash} ${repo.lastCommit.subject}`}>
          Last: {repo.lastCommit.subject} · {ago(repo.lastCommit.at)}
        </div>
      )}

      {n > 0 ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 12 }}>
            {shown.map((c) => {
              const [mark, color] = MARK[c.status];
              return (
                <div key={c.path} className="mono" style={{ display: "flex", gap: 8, fontSize: 11.5, minWidth: 0 }} title={`${c.status}: ${c.path}`}>
                  <b style={{ color, width: 10, flex: "none" }}>{mark}</b>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.path}</span>
                </div>
              );
            })}
            {n > SHOWN && (
              <button className="ibtn" style={{ width: "auto", height: 24, fontSize: 12, padding: "0 6px", alignSelf: "flex-start" }} onClick={() => setAll(!all)}>
                {all ? "Show fewer" : `${n - SHOWN} more`}
              </button>
            )}
          </div>
          <input className="field" style={{ marginTop: 12 }} value={message} placeholder={repo.suggestion || "Commit message"}
            aria-label={`Commit message for ${repo.name}`}
            onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) doCommit(); }} />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Commits all {n} {n === 1 ? "change" : "changes"}{message.trim() ? "" : " with the message shown"}.</div>
        </>
      ) : (
        <div className="muted" style={{ marginTop: 12 }}>No changes to commit.</div>
      )}

      {repo.remote ? (
        <div className="grid3" style={{ marginTop: 12 }}>
          <button className={`cta cta-md${n ? " go" : ""}`} disabled={!n || !!busy} onClick={doCommit}>{busy === "commit" ? "Committing…" : "Commit"}</button>
          <button className={`cta cta-md${!n && repo.behind ? " go" : ""}`} disabled={!repo.upstream || !!busy} onClick={doPull}
            title={repo.upstream ? `Pull from ${repo.upstream}` : "Push once first"}>{busy === "pull" ? "Pulling…" : repo.behind ? `Pull ${repo.behind}` : "Pull"}</button>
          <button className={`cta cta-md${!n && !repo.behind && unpushed ? " go" : ""}`} disabled={!unpushed || !!busy} onClick={doPush}>{busy === "push" ? "Pushing…" : "Push"}</button>
        </div>
      ) : (
        <>
          <button className={`cta cta-md${n ? " go" : ""}`} style={{ marginTop: 12 }} disabled={!n || !!busy} onClick={doCommit}>{busy === "commit" ? "Committing…" : "Commit"}</button>
          <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>To push, add a remote (an empty repository on GitHub or anywhere else):</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input className="field" value={remote} placeholder="git@github.com:you/prints.git" aria-label={`Remote URL for ${repo.name}`}
              onChange={(e) => setRemote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && remote.trim() && !busy) doRemote(); }} />
            <button className="cta cta-sm" style={{ padding: "0 12px", flex: "none" }} disabled={!remote.trim() || !!busy} onClick={doRemote}>Add</button>
          </div>
        </>
      )}
    </div>
  );
}
