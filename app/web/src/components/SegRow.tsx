/** A setting on one line: its label on the left, a small segmented picker on the right. */
export function SegRow<T extends string>({ label, options, value, disabled, onPick }: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T | null;
  disabled?: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flexGrow: 1 }}>{label}</span>
      <div className="seg seg-sm" role="radiogroup" aria-label={label} style={{ flex: "none" }}>
        {options.map((o) => (
          <button key={o.value} role="radio" aria-checked={value === o.value} disabled={disabled || value === null} title={o.title}
            style={{ padding: "0 10px" }} onClick={() => value !== o.value && onPick(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}
