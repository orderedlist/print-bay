#!/usr/bin/env python3
"""
run.py - slice a job with OrcaSlicer's CLI, then print it on the K2.

  python scripts/run.py jobs/stacking-box.toml              # slice + print all copies
  python scripts/run.py jobs/stacking-box.toml --slice-only # just make the G-code
  python scripts/run.py jobs/stacking-box.toml --no-slice   # reuse existing G-code
  python scripts/run.py jobs/stacking-box.toml --copies 1   # override copy count
  python scripts/run.py jobs/stacking-box.toml --color red  # override the job's color

A job prints in its `color` (a name like "black" or a hex code) from whichever
CFS slot holds it. A multi-colour OpenSCAD job lists its parts instead:

  [parts]          # each renders with -D part="<name>"; filament 1, 2, ... in this order
  disc = "white"
  x    = "blue"

The parts are sliced as one object with a filament each, so the colours print
together layer by layer and come off the bed as one piece.

Set ORCA to your OrcaSlicer binary if it isn't at the macOS default.
"""
import os
import re
import sys
import time
import shutil
import argparse
import subprocess
import json
import tomllib
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k2  # noqa: E402
import parts3mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ORCA = os.environ.get("ORCA", "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")
OPENSCAD = os.environ.get("OPENSCAD", "openscad")
DONE_STATES = {"complete", "cancelled", "error"}
COLORS = {
    "black": "#000000", "white": "#FFFFFF", "grey": "#808080", "gray": "#808080",
    "red": "#C12E1F", "orange": "#FF6A13", "yellow": "#F4D53F", "green": "#00AE42",
    "blue": "#0A2989", "purple": "#5E43B7", "pink": "#E4BDD0", "brown": "#7C4B00",
}
MAX_COLOR_DISTANCE = 120  # RGB distance; further than this isn't a match


def load_job(path):
    with open(path, "rb") as fh:
        job = tomllib.load(fh)
    for key in ("name", "model", "profiles"):
        if key not in job:
            sys.exit(f"{path}: missing '{key}'")
    return job


def slice_job(job):
    model = ROOT / job["model"]
    p = {k: ROOT / v for k, v in job["profiles"].items()}
    for f in [model, *p.values()]:
        if not f.exists():
            sys.exit(f"Missing file: {f.relative_to(ROOT)}")

    out = ROOT / "gcode" / job["name"]
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    process, filaments = p["process"], [p["filament"]]
    parts = job.get("parts")
    if parts:
        if model.suffix != ".scad":
            sys.exit("[parts] needs an OpenSCAD model (each part renders with -D part=...)")
        rendered = [(name, render_scad(model, out / f"part-{name}.stl", {**job.get("scad", {}), "part": f'"{name}"'}), i)
                    for i, name in enumerate(parts, 1)]
        model = parts3mf.write(rendered, out / "model.3mf", job["name"])
        process, filaments = multi_filament(p["process"], p["filament"], list(parts.values()), out)
    elif model.suffix == ".scad":
        model = render_scad(model, out / "model.stl", job.get("scad", {}))
    elif model.suffix == ".3mf":
        model = single_filament(model, out / "model.3mf")

    cmd = [
        ORCA,
        "--load-settings", f"{p['machine']};{process}",
        "--load-filaments", ";".join(str(f) for f in filaments),
        "--slice", "0",
        "--outputdir", str(out),
        str(model),
    ]
    print("Slicing:\n  " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    gcodes = sorted(out.glob("*.gcode"), key=lambda f: f.stat().st_mtime)
    if res.returncode != 0 or not gcodes:
        print(res.stdout[-2000:], res.stderr[-2000:], sep="\n")
        sys.exit("Slicing failed (output above).")

    final = ROOT / "gcode" / f"{job['name']}.gcode"
    shutil.move(gcodes[-1], final)
    shutil.rmtree(out, ignore_errors=True)
    print(f"G-code: {final.relative_to(ROOT)}")
    return final


def render_scad(src, dest, params=None):
    """Render to STL; `params` (the job's [scad] table) override top-level variables."""
    print(f"Rendering {src.relative_to(ROOT)}")
    overrides = [arg for k, v in (params or {}).items() for arg in ("-D", f"{k}={v}")]
    res = subprocess.run([OPENSCAD, *overrides, "-o", str(dest), str(src)], capture_output=True, text=True)
    if res.returncode != 0 or not dest.exists():
        print(res.stderr[-2000:])
        sys.exit("OpenSCAD render failed (output above).")
    return dest


def hex_for(color):
    return COLORS.get(color.lower(), color if color.startswith("#") else f"#{color}")


def multi_filament(process, filament, colors, out):
    """A filament profile per part, coloured like it, and the purge table to go with them.

    The CLI crashes on a multi-filament object without filament colours and a
    flush table; the colours also only matter for purging, not for which slot prints.
    """
    files = []
    base = json.loads(Path(filament).read_text())
    for i, color in enumerate(colors, 1):
        f = out / f"filament-{i}.json"
        f.write_text(json.dumps({**base, "filament_colour": [hex_for(color)]}))
        files.append(f)
    n = len(colors)
    proc = json.loads(Path(process).read_text())
    proc["flush_volumes_matrix"] = ["0" if i == j else "280" for i in range(n) for j in range(n)]
    proc["flush_volumes_vector"] = ["140"] * (2 * n)
    f = out / "process.json"
    f.write_text(json.dumps(proc))
    return f, files


def single_filament(src, dest):
    """Copy a 3MF with every object on filament 1, so our filament profile applies."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "Metadata/model_settings.config":
                data = re.sub(rb'(key="extruder" value=")\d+"', rb'\g<1>1"', data)
            zout.writestr(item, data)
    return dest


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
    a = ap.parse_args()

    job = load_job(a.job)
    gcode = ROOT / "gcode" / f"{job['name']}.gcode"

    if not a.no_slice:
        gcode = slice_job(job)
    elif not gcode.exists():
        sys.exit(f"No G-code at {gcode.relative_to(ROOT)}; run without --no-slice.")
    if a.slice_only:
        return

    colors = list(job["parts"].values()) if job.get("parts") else [a.color or job.get("color")]
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
