#!/usr/bin/env python3
"""
view.py - browse the repo's models in 3D.

  python scripts/view.py            # http://localhost:8765
  python scripts/view.py --port 9000

Lists every models/<name>/ folder with its SOURCE.md, the jobs that print it,
and stats from the last slice. Sliced jobs can also be viewed as toolpaths,
colored by feature (walls, infill, skins...), layer by layer. Meshes are served as STL: OpenSCAD models are
rendered upright, 3MFs have their meshes pulled out. Results are cached in
.cache/viewer/ until the source changes.
"""
import re
import sys
import json
import struct
import argparse
from array import array
import subprocess
import tomllib
import zipfile
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).parent))
from run import COLORS, OPENSCAD  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "viewer" / "index.html"
CACHE = ROOT / ".cache" / "viewer"
COSTS = ROOT / "costs.toml"
MESH_TYPES = (".scad", ".3mf", ".stl")


def jobs():
    found = []
    for f in sorted((ROOT / "jobs").glob("*.toml")):
        with f.open("rb") as fh:
            job = tomllib.load(fh)
        job["file"] = f.relative_to(ROOT).as_posix()
        found.append(job)
    return found


def rates():
    with COSTS.open("rb") as fh:
        return tomllib.load(fh)


def seconds(duration):
    """'7h 18m 29s' (or '1d 2h 3m 4s') -> seconds."""
    units = {"d": 86400, "h": 3600, "m": 60, "s": 1}
    return sum(int(n) * units[u] for n, u in re.findall(r"(\d+)([dhms])", duration))


def cost(stats, r):
    filament = stats["grams"] / 1000 * r["filament_per_kg"]
    power = stats["seconds"] / 3600 * r["printer_watts"] / 1000 * r["power_per_kwh"]
    return {"filament": round(filament, 2), "power": round(power, 2),
            "total": round(filament + power, 2)}


def gcode_stats(name):
    gcode = ROOT / "gcode" / f"{name}.gcode"
    if not gcode.exists():
        return None
    with gcode.open("rb") as fh:
        fh.seek(max(0, gcode.stat().st_size - 200_000))
        tail = fh.read().decode(errors="replace")
    time = re.search(r"^; estimated printing time \(normal mode\) = (.+)$", tail, re.M)
    grams = re.search(r"^; total filament used \[g\] = ([\d.]+)", tail, re.M)
    if not (time and grams):
        return None
    return {
        "time": time.group(1).strip(),
        "seconds": seconds(time.group(1)),
        "grams": float(grams.group(1)),
    }


def models():
    all_jobs = jobs()
    r = rates()
    found = []
    for d in sorted(p for p in (ROOT / "models").iterdir() if p.is_dir()):
        mesh = next((f for ext in MESH_TYPES for f in sorted(d.glob(f"*{ext}"))), None)
        source = d / "SOURCE.md"
        model_jobs = []
        for job in all_jobs:
            if Path(job["model"]).parent != d.relative_to(ROOT):
                continue
            color = job.get("color")
            stats = gcode_stats(job["name"])
            if stats:
                stats["cost"] = cost(stats, r)
            model_jobs.append({
                "name": job["name"],
                "file": job["file"],
                "color": color,
                "hex": COLORS.get(color.lower(), color) if color else None,
                "copies": job.get("copies", 1),
                "stats": stats,
            })
            mesh = ROOT / job["model"]
        found.append({
            "id": d.name,
            "file": mesh.relative_to(ROOT).as_posix() if mesh else None,
            "kind": mesh.suffix[1:] if mesh else None,
            "source": source.read_text() if source.exists() else "",
            "jobs": model_jobs,
        })
    return found


def write_stl(triangles, dest):
    with dest.open("wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(triangles)))
        for tri in triangles:
            fh.write(struct.pack("<12fH", 0, 0, 0, *tri[0], *tri[1], *tri[2], 0))


def threemf_to_stl(src, dest):
    """Every mesh object in the 3MF, in its own coordinates (placement ignored)."""
    triangles = []
    with zipfile.ZipFile(src) as z:
        for name in z.namelist():
            if not name.endswith(".model"):
                continue
            xml = z.read(name).decode()
            for obj in re.findall(r"<object\b.*?</object>", xml, re.S):
                verts = [tuple(map(float, v)) for v in re.findall(
                    r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', obj)]
                for a, b, c in re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', obj):
                    triangles.append((verts[int(a)], verts[int(b)], verts[int(c)]))
    write_stl(triangles, dest)


def mesh_for(model_id):
    model = next((m for m in models() if m["id"] == model_id and m["file"]), None)
    if not model:
        return None
    src = ROOT / model["file"]
    if src.suffix == ".stl":
        return src
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"{model_id}.stl"
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return dest
    if src.suffix == ".scad":
        res = subprocess.run([OPENSCAD, "-D", "upright=true", "-o", str(dest), str(src)],
                             capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(res.stderr[-1000:])
    else:
        threemf_to_stl(src, dest)
    return dest


MOVE = re.compile(r"^G[0-3]\b")
AXIS = re.compile(r"([XYZE])(-?[\d.]+)")


def parse_toolpaths(gcode):
    """Extrusion moves grouped by feature type, each as (x0, y0, z, x1, y1, z)."""
    segs, layer_of = {}, {}
    x = y = z = 0.0
    relative_e, e_abs, layer, kind = True, 0.0, -1, "Custom"
    layers = []
    with gcode.open() as fh:
        for line in fh:
            if line.startswith(";"):
                if line.startswith(";TYPE:"):
                    kind = line[6:].strip()
                elif line.startswith(";LAYER_CHANGE"):
                    layer += 1
                elif line.startswith(";Z:"):
                    z = float(line[3:])
                    if layer >= 0:
                        layers[layer:] = [z]
                continue
            if line.startswith("M83"):
                relative_e = True
            elif line.startswith("M82"):
                relative_e = False
            elif line.startswith("G92") and "E" in line:
                e_abs = 0.0
            elif MOVE.match(line):
                vals = dict(AXIS.findall(line.split(";")[0]))
                nx, ny = float(vals.get("X", x)), float(vals.get("Y", y))
                if "Z" in vals:
                    z = float(vals["Z"])
                de = 0.0
                if "E" in vals:
                    e = float(vals["E"])
                    de = e if relative_e else e - e_abs
                    e_abs = e if not relative_e else e_abs
                if de > 0 and (nx != x or ny != y) and layer >= 0:
                    segs.setdefault(kind, array("f")).extend((x, y, z, nx, ny, z))
                    layer_of.setdefault(kind, array("H")).append(layer)
                x, y = nx, ny
    return segs, layer_of, layers


def toolpaths_for(job_name):
    gcode = ROOT / "gcode" / f"{job_name}.gcode"
    if not gcode.exists():
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"{job_name}.paths"
    if dest.exists() and dest.stat().st_mtime >= gcode.stat().st_mtime:
        return dest.read_bytes()

    segs, layer_of, layers = parse_toolpaths(gcode)
    meta, data, offset = {"layers": layers, "types": []}, array("f"), 0
    for kind, pts in segs.items():
        count = len(pts) // 6
        starts, li = [], layer_of[kind]
        i = 0
        for n in range(len(layers) + 1):  # first segment at or after each layer
            while i < count and li[i] < n:
                i += 1
            starts.append(i)
        meta["types"].append({"name": kind, "offset": offset, "count": count, "layerStarts": starts})
        data.extend(pts)
        offset += count
    header = json.dumps(meta).encode()
    header += b" " * (-len(header) % 4)
    body = struct.pack("<I", len(header)) + header + data.tobytes()
    dest.write_bytes(body)
    return body


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/":
                self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            elif path == "/api/rates":
                self.send(200, json.dumps(rates()).encode(), "application/json")
            elif path == "/api/models":
                self.send(200, json.dumps(models()).encode(), "application/json")
            elif path.startswith("/mesh/"):
                mesh = mesh_for(path.removeprefix("/mesh/"))
                if mesh:
                    self.send(200, mesh.read_bytes(), "model/stl")
                else:
                    self.send(404, b"No such model", "text/plain")
            elif path.startswith("/toolpaths/"):
                body = toolpaths_for(path.removeprefix("/toolpaths/"))
                if body:
                    self.send(200, body, "application/octet-stream")
                else:
                    self.send(404, b"Not sliced yet", "text/plain")
            else:
                self.send(404, b"Not found", "text/plain")
        except Exception as e:  # show render errors in the page instead of hanging
            self.send(500, str(e).encode(), "text/plain")

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    print(f"Viewer at http://localhost:{a.port}  (Ctrl-C to stop)")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
