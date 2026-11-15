#!/usr/bin/env python3
"""
run.py - slice a job with OrcaSlicer's CLI, then print it on the K2.

  python scripts/run.py jobs/stacking-box.toml              # slice + print all copies
  python scripts/run.py jobs/stacking-box.toml --slice-only # just make the G-code
  python scripts/run.py jobs/stacking-box.toml --no-slice   # reuse existing G-code
  python scripts/run.py jobs/stacking-box.toml --copies 1   # override copy count
  python scripts/run.py jobs/stacking-box.toml --color red  # override the job's color
  python scripts/run.py jobs/ball-marker.toml --per-plate 20 # 20 on the bed at once (OpenSCAD jobs)
  python scripts/run.py jobs/succulent-pot-3.toml --material wood # wood-fill spool: gcode/<job>-wood.gcode (or silk)
  python scripts/run.py jobs/succulent-pot-3.toml --nozzle 0.6     # 0.6 mm nozzle: gcode/<job>-0.6mm.gcode
  python scripts/run.py plates/succulent-fruit-fly-trap-plate-3.toml --one-color # every part from one spool: -1c

A job prints in its `color` (a name like "black" or a hex code) from whichever
CFS slot holds it. A multi-colour OpenSCAD job lists its parts instead:

  [parts]          # each renders with -D part="<name>"; filament 1, 2, ... in this order
  disc = "white"
  x    = "blue"

The parts are sliced as one object with a filament each, so the colours print
together layer by layer and come off the bed as one piece. Each layer starts
with the first part listed, so list what should go down first (a face-down
inlay) first.

A downloaded .3mf holding several parts (a plant and its pot, in different
colours) gets a job per part: `object = "Funnel"` slices just the object of that
name, on the plate the file puts it on. `fill_base = { radius = 25, height = 0.6 }`
also fills the bottom that far up within that radius of the object's middle,
smoothing away a logo pressed into its base.

A plate (plates/<name>.toml) prints several of those parts at once, each with
its own settings and colour, laid out by Orca:

  name  = "succulent-plate-1"
  label = "Plate 1"
  [plate]                       # job name = how many
  succulent-plant-3 = 1
  succulent-funnel  = 2

Slicing is Print Bay's (scripts/slice, app/server/src/slicer.ts), so build the app once
(cd app && npm install && npm run build). Set ORCA to your OrcaSlicer binary if it isn't
at the macOS default.
"""
import os
import re
import sys
import time
import argparse
import subprocess
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent  # the app: scripts/, app/
# the library (models/, jobs/, plates/, profiles/, gcode/), as the app finds it: PRINT_BAY_DATA, else the
# folder chosen in Print Bay's Settings, else this checkout if it has jobs/, else the standard place
SUPPORT = Path.home() / "Library/Application Support/Print Bay"


def find_library():
    if os.environ.get("PRINT_BAY_DATA"):
        return Path(os.environ["PRINT_BAY_DATA"])
    chosen = SUPPORT / "library-location"
    if chosen.exists() and chosen.read_text().strip():
        return Path(chosen.read_text().strip())
    return ROOT if (ROOT / "jobs").is_dir() else SUPPORT / "Library"


DATA = find_library().resolve()
SLICE = ROOT / "scripts/slice"  # Print Bay's slicer (app/server/src/slicer.ts): one slicer for the app and this script
DONE_STATES = {"complete", "cancelled", "error"}
COLORS = {
    "black": "#000000", "white": "#FFFFFF", "grey": "#808080", "gray": "#808080",
    "red": "#C12E1F", "orange": "#FF6A13", "yellow": "#F4D53F", "green": "#00AE42",
    "blue": "#0A2989", "purple": "#5E43B7", "pink": "#E4BDD0", "brown": "#7C4B00",
}
MAX_COLOR_DISTANCE = 120  # RGB distance; further than this isn't a match


def load_job(path):
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def slice_job(path, per_plate=1, material=None, nozzle=None, one_color=False, path_only=False):
    """Slice with Print Bay's slicer (progress shows as it goes); returns the G-code's path.

    With `path_only`, just where that G-code goes, without slicing.
    """
    args = [str(SLICE), str(path), "--per-plate", str(per_plate),
            *(["--material", material] if material else []), *(["--nozzle", nozzle] if nozzle else []),
            *(["--one-color"] if one_color else []), *(["--path-only"] if path_only else [])]
    res = subprocess.run(args, stdout=subprocess.PIPE, text=True, env={**os.environ, "PRINT_BAY_DATA": str(DATA)})
    if res.returncode != 0:
        sys.exit("Slicing failed (above).")
    return Path(res.stdout.strip().splitlines()[-1])


def hex_for(color):
    return COLORS.get(color.lower(), color if color.startswith("#") else f"#{color}")


def rgb(hex_color):
    h = hex_color.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def find_slot(color):
    target = hex_for(color)
    if not re.fullmatch(r"#?[0-9A-Fa-f]{6}", target):
        sys.exit(f"Unknown color '{color}'. Use one of {', '.join(COLORS)} or a hex code.")
    loaded = k2.slots()
    if not loaded:
        sys.exit("No filament reported in the CFS.")

    def distance(slot):
        return sum((a - b) ** 2 for a, b in zip(rgb(slot["color"]), rgb(target))) ** 0.5

    best = min(loaded, key=distance)
    if distance(best) > MAX_COLOR_DISTANCE:
        have = ", ".join(f"{s['slot']} {s['color']}" for s in loaded)
        sys.exit(f"No {color} loaded (have {have}).")
    return best


def for_slots(gcode, slots):
    """Write a copy of the G-code whose filament i (T<i>) pulls from slots[i] in the CFS."""
    text = gcode.read_text()
    tools = {int(t) for t in re.findall(r"^T(\d+)\s*$", text, re.M)}
    if max(tools, default=0) >= len(slots):
        sys.exit(f"{gcode.name} uses filaments {sorted(tools)} but only {len(slots)} colour(s) were given.")
    out = gcode.with_name(f"{gcode.stem}-{'-'.join(s['slot'] for s in slots)}.gcode")
    out.write_text(re.sub(r"^T(\d+)\s*$", lambda m: f"T{slots[int(m[1])]['tool']}", text, flags=re.M))
    return out


def wait_for_finish(poll=10):
    time.sleep(15)  # let Klipper move from standby to printing
    while True:
        s = k2.get_status()
        print("\r" + k2.fmt_status(s).ljust(110), end="", flush=True)
        state = s.get("print_stats", {}).get("state")
        if state in DONE_STATES:
            print()
            return state
        time.sleep(poll)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    ap.add_argument("--slice-only", action="store_true")
    ap.add_argument("--no-slice", action="store_true")
    ap.add_argument("--copies", type=int)
    ap.add_argument("--color")
    ap.add_argument("--per-plate", type=int, default=1, help="lay this many out on the bed at once")
    ap.add_argument("--material", help="slice for this filament instead of PLA (wood, silk)")
    ap.add_argument("--nozzle", help="slice for this nozzle (mm) instead of the stock 0.4 (0.6)")
    ap.add_argument("--one-color", action="store_true", help="a multi-colour job all from one spool (--color)")
    a = ap.parse_args()

    job = load_job(a.job)
    gcode = slice_job(a.job, a.per_plate, a.material, a.nozzle, a.one_color, path_only=a.no_slice)
    if a.no_slice and not gcode.exists():
        sys.exit(f"No G-code at {gcode.relative_to(DATA)}; run without --no-slice.")
    if a.slice_only:
        return

    colors = list(job["parts"].values()) if job.get("parts") and not a.one_color else [a.color or job.get("color")]
    if not all(colors):
        sys.exit("No color: set `color` in the job or pass --color.")
    slots = [find_slot(c) for c in colors]
    for c, slot in zip(colors, slots):
        print(f"{c} from {slot['slot']} ({slot['color']}, {slot['remain']}% left)")
    gcode = for_slots(gcode, slots)

    copies = a.copies or job.get("copies", 1)
    k2.upload(gcode)
    for i in range(1, copies + 1):
        if i > 1:
            input(f"\nClear the bed, then press Enter for copy {i}/{copies}...")
        print(f"Starting copy {i}/{copies}")
        k2.api("POST", "/printer/print/start", params={"filename": gcode.name})
        state = wait_for_finish()
        if state != "complete":
            sys.exit(f"Print ended as '{state}'; stopping the run.")
    print("All copies done.")


if __name__ == "__main__":
    main()
