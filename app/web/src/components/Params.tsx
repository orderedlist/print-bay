import type { ScadParam } from "../types";

// Each OpenSCAD parameter gets the control its customizer comment asks for:
//   reach = 50;     // [30:80] dowel centre out from the wall      -> slider + exact field
//   wall = 1.8;     // [1.2:0.2:3.2] plate thickness               -> slider with a step
//   rows = 3;       // [1:6] bays up                               -> − / + stepper (whole numbers from 1, short range)
//   screw = 4.5;    // [3.4:M3, 4.5:M4 / #8, 5.5:M5] clearance     -> one button per choice
// Anything else (no range, or a value like "3.25 * in") is a plain field.

type Spec =
  | { kind: "range"; min: number; max: number; step: number; note: string }
  | { kind: "count"; min: number; max: number; note: string }
  | { kind: "choice"; options: { value: string; label: string }[]; note: string }
  | { kind: "field"; note: string };

const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;
const decimals = (n: string) => (n.split(".")[1] ?? "").length;

export function spec(p: ScadParam): Spec {
  const m = p.comment.match(/^\[([^\]]*)\]\s*(.*)$/);
  if (!m) return { kind: "field", note: p.comment };
  const [, inner, note] = m;
  if (inner.includes(",")) {
    const options = inner.split(",").map((o) => {
      const [value, ...label] = o.split(":").map((x) => x.trim());
      return { value, label: label.join(":") || value };
    }).filter((o) => o.value);
    return { kind: "choice", options, note };
  }
  const nums = inner.split(":").map((x) => x.trim());
  if (!NUMBER.test(p.value.trim()) || !nums.every((n) => NUMBER.test(n))) return { kind: "field", note };
  const [min, step, max] = nums.length === 3 ? nums : nums.length === 2 ? [nums[0], "", nums[1]] : ["0", "", nums[0]];
  const lo = Number(min), hi = Number(max);
  if (!(hi > lo)) return { kind: "field", note };
  const places = step ? decimals(step) : Math.max(decimals(min), decimals(max), decimals(p.default), decimals(p.value));
  const stepN = step ? Number(step) : 10 ** -places;
  // counts: whole numbers from 1 over a short range, or an explicit step of 1 ([0:1:3])
  const whole = stepN === 1 && Number.isInteger(lo) && Number.isInteger(hi) && hi - lo <= 10;
  if (whole && (lo >= 1 || step === "1")) return { kind: "count", min: lo, max: hi, note };
  return { kind: "range", min: lo, max: hi, step: stepN, note };
}

/** "plate_h" -> "Plate h", "dowel_dia" -> "Dowel dia" */
const label = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

interface Props {
  params: ScadParam[];
  value: (p: ScadParam) => string;
  set: (name: string, value: string) => void;
}

export function Params({ params, value, set }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {params.map((p) => {
        const s = spec(p);
        const v = value(p);
        const changed = v.trim() !== p.default;
        const id = `param-${p.name}`;
        const head = (control: React.ReactNode) => (
          <div className="prm-h">
            <label className={changed ? "prm-l mod" : "prm-l"} htmlFor={id} title={p.name}>{label(p.name)}</label>
            {control}
          </div>
        );
        const note = s.note && <div className="prm-note">{s.note}</div>;

        if (s.kind === "range") {
          const n = Number(v);
          const fill = `${Math.min(100, Math.max(0, ((n - s.min) / (s.max - s.min)) * 100))}%`;
          return (
            <div key={p.name} className="prm">
              {head(<span className="num mono"><input id={id} type="number" min={s.min} max={s.max} step={s.step} value={v}
                onChange={(e) => set(p.name, e.target.value)} /></span>)}
              <input className="rng" type="range" min={s.min} max={s.max} step={s.step} value={NUMBER.test(v) ? n : s.min}
                aria-label={label(p.name)} style={{ ["--f" as string]: fill }} onChange={(e) => set(p.name, e.target.value)} />
              <div className="ends"><span>{s.min}</span><span>{s.max}</span></div>
              {note}
            </div>
          );
        }
        if (s.kind === "count") {
          const n = Math.round(Number(v)) || s.min;
          return (
            <div key={p.name} className="prm">
              {head(<div className="step mono" role="group" aria-label={label(p.name)}>
                <button id={id} disabled={n <= s.min} onClick={() => set(p.name, String(n - 1))} aria-label="Fewer">−</button>
                <b>{n}</b>
                <button disabled={n >= s.max} onClick={() => set(p.name, String(n + 1))} aria-label="More">+</button>
              </div>)}
              {note}
            </div>
          );
        }
        if (s.kind === "choice") {
          return (
            <div key={p.name} className="prm">
              {head(null)}
              <div className="seg seg-sm" role="radiogroup" aria-label={label(p.name)}>
                {s.options.map((o, i) => (
                  <button key={o.value} id={i === 0 ? id : undefined} role="radio" aria-checked={Number(o.value) === Number(v) || o.value === v.trim()}
                    onClick={() => set(p.name, o.value)}>{o.label}</button>
                ))}
              </div>
              {note}
            </div>
          );
        }
        return (
          <div key={p.name} className="prm">
            {head(<span className="num wide mono"><input id={id} value={v} spellCheck={false} onChange={(e) => set(p.name, e.target.value)} /></span>)}
            {note}
          </div>
        );
      })}
    </div>
  );
}
