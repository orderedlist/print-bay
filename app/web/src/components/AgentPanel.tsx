import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api, money } from "../api";
import type { AgentEntry, AgentSession } from "../types";

/** Just enough Markdown for chat replies: paragraphs, lists, **bold**, `code`. */
function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
        : part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>);
  // runs of consecutive list items become lists; everything else, paragraphs
  const BULLET = /^\s*([-*]|\d+\.)\s/;
  const runs: { list: boolean; lines: string[] }[] = [];
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) { runs.push({ list: false, lines: [] }); continue; }
    const list = BULLET.test(line);
    const last = runs[runs.length - 1];
    if (last && last.list === list && last.lines.length) last.lines.push(line);
    else runs.push({ list, lines: [line] });
  }
  return (
    <>
      {runs.filter((r) => r.lines.length).map((r, i) => r.list
        ? <ul key={i}>{r.lines.map((l, j) => <li key={j}>{inline(l.replace(BULLET, ""))}</li>)}</ul>
        : <p key={i}>{r.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l.replace(/^#+\s/, ""))}</Fragment>)}</p>)}
    </>
  );
}

function ToolLine({ entry }: { entry: Extract<AgentEntry, { role: "tool" }> }) {
  const mark = entry.ok === null ? "…" : entry.ok ? "✓" : "✕";
  return (
    <div className="agent-tool" data-state={entry.ok === null ? "running" : entry.ok ? "ok" : "denied"}>
      <span aria-hidden="true">{mark}</span> {entry.label}{entry.ok === false && <span className="faint"> (not allowed)</span>}
    </div>
  );
}

interface Props {
  session: AgentSession;
  placeholder: string;
  allowUploads?: boolean;
  empty?: ReactNode;
  /** Prompt starting points: clicking one fills the composer (it isn't sent). */
  starters?: string[];
  toast: (msg: string, error?: boolean) => void;
}

export function AgentPanel({ session, placeholder, allowUploads, empty, starters, toast }: Props) {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const base = `/api/agent/${session.id}`;

  useEffect(() => { // follow the conversation
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.transcript]);

  const upload = async (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) { toast(`${file.name} isn't a photo`, true); continue; }
      setUploading((n) => n + 1);
      try {
        const { name } = await api<{ name: string }>(`${base}/uploads`, { method: "POST", body: file, headers: { "Content-Type": file.type } });
        setUploads((u) => [...u, name]);
      } catch (e) { toast((e as Error).message, true); }
      setUploading((n) => n - 1);
    }
  };

  const send = async () => {
    if (session.running || (!text.trim() && !uploads.length)) return;
    try {
      await api(`${base}/messages`, { method: "POST", json: { text, uploads } });
      setText("");
      setUploads([]);
    } catch (e) { toast((e as Error).message, true); }
  };

  const call = (action: "stop" | "undo") =>
    api(`${base}/${action}`, { method: "POST" }).catch((e) => toast(e.message, true));

  return (
    <div className={`agent ${dragging ? "agent-drop" : ""}`}
      onDragOver={allowUploads ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
      onDragLeave={allowUploads ? () => setDragging(false) : undefined}
      onDrop={allowUploads ? (e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); } : undefined}>
      <div className="agent-log" ref={scroller} aria-live="polite">
        {session.transcript.length === 0 && empty}
        {session.transcript.map((entry, i) => {
          if (entry.role === "user") return (
            <div key={i} className="agent-user">
              {entry.uploads.length > 0 && (
                <div className="agent-photos">{entry.uploads.map((u) => <img key={u} src={`${base}/uploads/${u}`} alt="Attached photo" />)}</div>
              )}
              {entry.text && <div>{entry.text}</div>}
            </div>
          );
          if (entry.role === "assistant") return entry.text.trim() ? <div key={i} className="agent-reply"><Markdown text={entry.text} /></div> : null;
          if (entry.role === "tool") return <ToolLine key={i} entry={entry} />;
          return <div key={i} className={entry.error ? "agent-note agent-error" : "agent-note"} style={{ whiteSpace: "pre-wrap" }}>{entry.text}</div>;
        })}
        {session.running && <div className="agent-note"><span className="agent-spinner" aria-hidden="true" /> Claude is working…</div>}
      </div>

      <div className="agent-compose">
        {starters && !session.running && !text && (
          <div className="starters" aria-label="Starting points">
            {starters.map((s) => (
              <button key={s} className="starter" onClick={() => { setText(s); input.current?.focus(); }}>{s}</button>
            ))}
          </div>
        )}
        {(uploads.length > 0 || uploading > 0) && (
          <div className="agent-photos">
            {uploads.map((u) => (
              <button key={u} className="agent-thumb" onClick={() => setUploads(uploads.filter((x) => x !== u))} aria-label="Remove photo">
                <img src={`${base}/uploads/${u}`} alt="" />
              </button>
            ))}
            {uploading > 0 && <span className="muted" style={{ fontSize: 12 }}>Uploading…</span>}
          </div>
        )}
        <textarea ref={input} className="field agent-input" rows={3} value={text} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={allowUploads ? (e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); upload(files); } } : undefined}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="agent-actions">
          {allowUploads && <>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
            <button className="btn btn-sm" onClick={() => fileInput.current?.click()}>Add photos</button>
          </>}
          <button className="btn btn-sm" disabled={session.running || session.turns === 0} onClick={() => call("undo")}
            title="Restore the files from before Claude's last change">Undo last change</button>
          <span className="spacer" />
          {session.cost >= 0.01 && <span className="faint mono" style={{ fontSize: 11 }} title="Claude usage for this chat">{money(session.cost)}</span>}
          {session.running
            ? <button className="btn btn-sm btn-danger" onClick={() => call("stop")}>Stop</button>
            : <button className="btn btn-sm btn-primary" disabled={!text.trim() && !uploads.length} onClick={send}>Send</button>}
        </div>
      </div>
    </div>
  );
}
