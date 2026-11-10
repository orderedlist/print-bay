#!/usr/bin/env python3
"""
run.py - slice a job with OrcaSlicer's CLI, then print it on the K2.

  python scripts/run.py jobs/stacking-box.toml              # slice + print all copies
  python scripts/run.py jobs/stacking-box.toml --slice-only # just make the G-code
  python scripts/run.py jobs/stacking-box.toml --no-slice   # reuse existing G-code
  python scripts/run.py jobs/stacking-box.toml --copies 1   # override copy count
  python scripts/run.py jobs/stacking-box.toml --color red  # override the job's color
  python scripts/run.py jobs/ball-marker.toml --per-plate 20 # 20 on the bed at once (OpenSCAD jobs)

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
# nurb parts (.py) build in nurb's own environment, which the nurb app installs
NURB_PYTHON = os.environ.get(
    "NURB_PYTHON", str(Path.home() / "Library/Application Support/dev.nurb.desktop/env/bin/python"))
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


def gcode_name(job, per_plate=1):
    """gcode/<job>.gcode, or gcode/<job>-x<n>.gcode for n to a plate."""
    return f"{job['name']}-x{per_plate}" if per_plate > 1 else job["name"]


def slice_job(job, per_plate=1):
    model = ROOT / job["model"]
    p = {k: ROOT / v for k, v in job["profiles"].items()}
    for f in [model, *p.values()]:
        if not f.exists():
            sys.exit(f"Missing file: {f.relative_to(ROOT)}")

    if per_plate > 1 and model.suffix not in (".scad", ".py"):
        sys.exit("Filling the plate works for OpenSCAD and nurb models; this one is a ready-made file.")
    out = ROOT / "gcode" / gcode_name(job, per_plate)
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    plate = 0  # 0 = every plate
    # the job's [overrides.process] go on top every slice, so a job can tune a shared profile
    process, filaments = with_overrides(p["process"], job.get("overrides", {}).get("process", {}), out), [p["filament"]]
    parts = job.get("parts")
    if parts:
        if model.suffix != ".scad":
            sys.exit("[parts] needs an OpenSCAD model (each part renders with -D part=...)")
        rendered = [(name, render_scad(model, out / f"part-{name}.stl", {**job.get("scad", {}), "part": f'"{name}"'}), i)
                    for i, name in enumerate(parts, 1)]
        model = parts3mf.write(rendered, out / "model.3mf", job["name"], copies=per_plate)
        process, filaments = multi_filament(process, p["filament"], list(parts.values()), out)
    elif model.suffix in (".scad", ".py"):
        stl = (render_scad(model, out / "model.stl", job.get("scad", {})) if model.suffix == ".scad"
               else render_nurb(model, out / "model.stl", job.get("params", {})))
        model = parts3mf.write([(job["name"], stl, 1)], out / "model.3mf", job["name"], copies=per_plate)
    elif model.suffix == ".3mf":
        model, plate = single_filament(model, out / "model.3mf", job.get("object"), job.get("fill_base"))

    # OpenSCAD models arrive centred and laid out as the .scad intends (see parts3mf); Orca's
    # auto-arrange would spin them (a 45-degree turn of a two-colour inlay, say), so it's off
    # for those. Downloaded 3MFs keep Orca's placement.
    placed = job["model"].endswith((".scad", ".py"))
    cmd = [
        ORCA,
        "--load-settings", f"{p['machine']};{process}",
        "--load-filaments", ";".join(str(f) for f in filaments),
        "--slice", str(plate),
        *(["--arrange", "0", "--orient", "0"] if placed else []),
        "--outputdir", str(out),
        str(model),
    ]
    print("Slicing:\n  " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    gcodes = sorted(out.glob("*.gcode"), key=lambda f: f.stat().st_mtime)
    if res.returncode != 0 or not gcodes:
        print(res.stdout[-2000:], res.stderr[-2000:], sep="\n")
        sys.exit("Slicing failed (output above).")

    final = ROOT / "gcode" / f"{gcode_name(job, per_plate)}.gcode"
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


def render_nurb(src, dest, params=None):
    """Build a nurb part (laid out to print, its default) with the job's [params] as keyword arguments."""
    print(f"Building {src.relative_to(ROOT)} with nurb")
    sets = [f"{k}={v}" for k, v in (params or {}).items()]
    res = subprocess.run([NURB_PYTHON, str(ROOT / "scripts/nurb_part.py"), str(src), str(dest), *sets],
                         capture_output=True, text=True, cwd=ROOT)
    if res.returncode != 0 or not dest.exists():
        print(res.stdout[-2000:], res.stderr[-2000:], sep="\n")
        sys.exit("nurb build failed (output above).")
    return dest


def hex_for(color):
    return COLORS.get(color.lower(), color if color.startswith("#") else f"#{color}")


def with_overrides(process, overrides, out):
    if not overrides:
        return process
    f = out / "process.json"
    f.write_text(json.dumps({**json.loads(Path(process).read_text()), **{k: str(v) for k, v in overrides.items()}}))
    return f


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
    # the first layer goes down in [parts] order (Orca otherwise picks, e.g. the disc before its inlay)
    proc["first_layer_print_sequence"] = [str(i) for i in range(1, n + 1)]
    # the prime tower goes in the back-right corner that parts3mf.grid() keeps clear
    proc["wipe_tower_x"] = [str(parts3mf.TOWER[0] + 12)]
    proc["wipe_tower_y"] = [str(parts3mf.TOWER[1] + 12)]
    f = out / "process.json"
    f.write_text(json.dumps(proc))
    return f, files


def single_filament(src, dest, only=None, fill_base=None):
    """Copy a 3MF with every object on filament 1, so our filament profile applies.

    With `only` (an object's name), the copy keeps just that object; returns the
    copy and the plate to slice (that object's, or 0 for every plate).

    Orca's CLI refuses files saved by Bambu Studio 2.x (exit 232, no message), so
    the copy claims to be from 1.10; the objects, modifiers and layer ranges read fine.
    Colour painting (paint_color on triangles) is dropped too: it outranks the object's
    filament, so a pot painted filament 2 would swap filaments every layer.

    `fill_base` (needs `only`) adds a solid disc to that object, flush with its underside.
    """
    plate = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        keep = None
        if only:
            keep, plate = object_on_plate(zin.read("Metadata/model_settings.config").decode(), only, src)
        extra = base_fill(zin, keep, fill_base) if keep and fill_base else {}
        for item in zin.infolist():
            data = extra.get(item.filename) or zin.read(item.filename)
            if item.filename == "Metadata/model_settings.config":
                data = re.sub(rb'(key="extruder" value=")\d+"', rb'\g<1>1"', data)
                if keep:  # the other objects' settings and plate entries go with their build items
                    data = re.sub(rb'\s*<object id="(\d+)">.*?</object>',
                                  lambda m: m[0] if m[1].decode() == keep else b"", data, flags=re.S)
                    data = re.sub(rb'\s*<assemble_item object_id="(\d+)"[^>]*/>',
                                  lambda m: m[0] if m[1].decode() == keep else b"", data)
                    data = re.sub(rb'\s*<model_instance>(?:(?!</model_instance>).)*?key="object_id" value="(\d+)"(?:(?!</model_instance>).)*</model_instance>',
                                  lambda m: m[0] if m[1].decode() == keep else b"", data, flags=re.S)
            elif item.filename == "3D/3dmodel.model":
                data = re.sub(rb'(<metadata name="Application">BambuStudio-)0*[2-9]\d*\.[\d.]+',
                              rb'\g<1>01.10.00.00', data)
                if keep:
                    data = re.sub(rb'\s*<item\b[^>]*?\bobjectid="(\d+)"[^>]*/>',
                                  lambda m: m[0] if m[1].decode() == keep else b"", data)
            if item.filename.endswith(".model"):
                data = re.sub(rb' paint_color="[^"]*"', b"", data)
            zout.writestr(item, data)
    return dest, plate


def base_fill(zin, keep, fill):
    """Changed files that add a disc (radius, height mm) under build object `keep`, as one more solid part.

    The disc sits in the object's own coordinates, centred on its main mesh and flush with
    that mesh's underside (after the component's transform), so the slicer unions it with
    the base: a recess up to `height` deep inside `radius` prints solid.
    """
    import math
    root = zin.read("3D/3dmodel.model").decode()
    obj = re.search(rf'<object id="{keep}"[^>]*>(.*?)</object>', root, re.S)
    comp = re.search(r'<component p:path="([^"]+)" objectid="(\d+)"[^>]*?transform="([^"]+)"', obj[1])
    if not comp:
        sys.exit("fill_base needs an object made of parts (a Bambu/Orca 3MF).")
    path, mesh_id, m = comp[1].lstrip("/"), comp[2], [float(x) for x in comp[3].split()]
    sub = zin.read(path).decode()
    mesh = re.search(rf'<object id="{mesh_id}"[^>]*>(.*?)</object>', sub, re.S)[1]
    pts = [(float(a), float(b), float(c)) for a, b, c in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', mesh)]
    pts = [tuple(x * m[c] + y * m[3 + c] + z * m[6 + c] + m[9 + c] for c in range(3)) for x, y, z in pts]
    xs, ys, zs = zip(*pts)
    cx, cy, z0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)
    r, h, n = float(fill["radius"]), float(fill["height"]), 96
    ring = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z0 + h) for x, y in ring] + [(cx, cy, z0), (cx, cy, z0 + h)]
    tris = []
    for i in range(n):
        j = (i + 1) % n
        tris += [(i, j, n + i), (j, n + j, n + i), (2 * n, j, i), (2 * n + 1, n + i, n + j)]  # normals out
    new_id = str(max(int(x) for x in re.findall(r'<object id="(\d+)"', sub + root)) + 1)
    disc = (f'<object id="{new_id}" type="model"><mesh><vertices>'
            + "".join(f'<vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>' for x, y, z in verts)
            + "</vertices><triangles>" + "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
            + "</triangles></mesh></object>\n")
    sub = sub.replace("</resources>", disc + "</resources>", 1)
    root = re.sub(rf'(<object id="{keep}"[^>]*>.*?)(</components>)',
                  lambda mm: mm[1] + f'<component p:path="/{path}" objectid="{new_id}" transform="1 0 0 0 1 0 0 0 1 0 0 0" />\n' + mm[2],
                  root, count=1, flags=re.S)
    config = zin.read("Metadata/model_settings.config").decode()
    config = re.sub(rf'(<object id="{keep}">.*?)(\s*</object>)',
                    lambda mm: mm[1] + f'\n    <part id="{new_id}" subtype="normal_part">\n      <metadata key="name" value="base fill"/>\n'
                    '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>' + mm[2],
                    config, count=1, flags=re.S)
    return {path: sub.encode(), "3D/3dmodel.model": root.encode(), "Metadata/model_settings.config": config.encode()}


def object_on_plate(config, name, src):
    """The build object named `name` in a 3MF's model_settings.config, and the plate it's on."""
    ids = [m[1] for m in re.finditer(r'<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"', config) if m[2] == name]
    if not ids:
        have = re.findall(r'<object id="\d+">\s*<metadata key="name" value="([^"]*)"', config)
        sys.exit(f"No object named '{name}' in {src} (has {', '.join(have)}).")
    for block in re.findall(r"<plate>(.*?)</plate>", config, re.S):
        if re.search(rf'key="object_id" value="{ids[0]}"', block):
            return ids[0], int(re.search(r'key="plater_id" value="(\d+)"', block)[1])
    return ids[0], 0


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
    a = ap.parse_args()

    job = load_job(a.job)
    gcode = ROOT / "gcode" / f"{gcode_name(job, a.per_plate)}.gcode"

    if not a.no_slice:
        gcode = slice_job(job, a.per_plate)
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
