// How many copies fit on one plate: the same layout as scripts/parts3mf.py's grid(),
// which is what actually places them. Keep the two in step.
const BED = 260, MARGIN = 4, GAP = 4, TOWER = 190;

/** `w` x `d` is the part's footprint as printed; `tower` keeps the prime tower corner clear (multi-colour). */
export function plateFit(w: number, d: number, tower: boolean): number {
  if (!(w > 0 && d > 0)) return 1;
  const cols = Math.floor((BED - 2 * MARGIN + GAP) / (w + GAP));
  const rows = Math.floor((BED - 2 * MARGIN + GAP) / (d + GAP));
  const x0 = BED / 2 - (cols * (w + GAP) - GAP) / 2 + w / 2;
  const y0 = BED / 2 - (rows * (d + GAP) - GAP) / 2 + d / 2;
  let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * (w + GAP), y = y0 + r * (d + GAP);
    if (!tower || x + w / 2 < TOWER || y + d / 2 < TOWER) n++;
  }
  return Math.max(1, n);
}
