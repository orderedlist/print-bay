#!/usr/bin/env python3
"""
view.py - browse the repo's models in 3D.

  python scripts/view.py            # http://localhost:8765
  python scripts/view.py --port 9000

Lists every models/<name>/ folder with its SOURCE.md, the jobs that print it,
and stats from the last slice. Meshes are served as STL: OpenSCAD models are
rendered upright, 3MFs have their meshes pulled out. Results are cached in
.cache/viewer/ until the source changes.
"""
import re
import sys
import json
import struct
import argparse
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
MESH_TYPES = (".scad", ".3mf", ".stl")


def jobs():
    found = []
    for f in sorted((ROOT / "jobs").glob("*.toml")):
        with f.open("rb") as fh:
            job = tomllib.load(fh)
        job["file"] = f.relative_to(ROOT).as_posix()
        found.append(job)
    return found


def gcode_stats(name):
    gcode = ROOT / "gcode" / f"{name}.gcode"
    if not gcode.exists():
        return None
    with gcode.open("rb") as fh:
        fh.seek(max(0, gcode.stat().st_size - 200_000))
        tail = fh.read().decode(errors="replace")
    time = re.search(r"^; estimated printing time \(normal mode\) = (.+)$", tail, re.M)
    grams = re.search(r"^; total filament used \[g\] = ([\d.]+)", tail, re.M)
    return {
        "time": time.group(1).strip() if time else None,
        "grams": float(grams.group(1)) if grams else None,
    }


def models():
    all_jobs = jobs()
    found = []
    for d in sorted(p for p in (ROOT / "models").iterdir() if p.is_dir()):
        mesh = next((f for ext in MESH_TYPES for f in sorted(d.glob(f"*{ext}"))), None)
        source = d / "SOURCE.md"
        model_jobs = []
        for job in all_jobs:
            if Path(job["model"]).parent != d.relative_to(ROOT):
                continue
            color = job.get("color")
            model_jobs.append({
                "name": job["name"],
                "file": job["file"],
                "color": color,
                "hex": COLORS.get(color.lower(), color) if color else None,
                "copies": job.get("copies", 1),
                "stats": gcode_stats(job["name"]),
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
            elif path == "/api/models":
                self.send(200, json.dumps(models()).encode(), "application/json")
            elif path.startswith("/mesh/"):
                mesh = mesh_for(path.removeprefix("/mesh/"))
                if mesh:
                    self.send(200, mesh.read_bytes(), "model/stl")
                else:
                    self.send(404, b"No such model", "text/plain")
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
