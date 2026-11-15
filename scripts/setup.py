#!/usr/bin/env python3
"""
setup.py - get everything a job needs before run.py can slice it.

  python scripts/setup.py jobs/stacking-box.toml

1. Installs OrcaSlicer with Homebrew if it's missing.
2. Opens the model's download page and waits for the .3mf to land in
   ~/Downloads, then moves it to the path the job expects.
3. Writes the job's profile files by flattening Orca's bundled system
   presets (named in the job's [presets]) and applying [overrides].

Each step is skipped if its output already exists; pass --force to
rebuild the profiles.
"""
import os
import sys
import json
import time
import shutil
import argparse
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # the app: scripts/
# the library (models/, jobs/, profiles/, gcode/), as the app finds it: PRINT_BAY_DATA, else the
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
ORCA = os.environ.get("ORCA", "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")
VENDORS = ("Creality", "OrcaFilamentLibrary")  # searched in order for presets
DOWNLOADS = Path.home() / "Downloads"


def install_orca():
    if Path(ORCA).exists():
        print(f"OrcaSlicer: {ORCA}")
        return
    if not shutil.which("brew"):
        sys.exit("OrcaSlicer is missing and Homebrew isn't installed; install Orca by hand.")
    print("Installing OrcaSlicer with Homebrew...")
    subprocess.run(["brew", "install", "--cask", "orcaslicer"], check=True)
    if not Path(ORCA).exists():
        sys.exit(f"Installed, but no binary at {ORCA}; set ORCA to its path.")


def fetch_model(job):
    model = DATA / job["model"]
    if model.exists():
        print(f"Model: {model.relative_to(DATA)}")
        return
    if "source" not in job:
        sys.exit(f"No model at {model.relative_to(DATA)} and no 'source' in the job to fetch it from.")

    started = time.time()
    print(f"Opening {job['source']}")
    print(f"Download the .3mf there; waiting for it in {DOWNLOADS} (Ctrl-C to stop)...")
    subprocess.run(["open", job["source"]], check=True)
    while True:
        new = [f for f in DOWNLOADS.glob("*.3mf") if f.stat().st_mtime > started]
        if new:
            found = max(new, key=lambda f: f.stat().st_mtime)
            time.sleep(2)  # let the browser finish writing
            model.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(found, model)
            print(f"Moved {found.name} -> {model.relative_to(DATA)}")
            return
        time.sleep(2)


def preset_index(kind):
    """Map preset name -> JSON path for one kind (machine/process/filament)."""
    resources = Path(ORCA).resolve().parent.parent / "Resources" / "profiles"
    index = {}
    for vendor in reversed(VENDORS):  # earlier vendors win
        for f in (resources / vendor / kind).glob("*.json"):
            try:
                data = json.loads(f.read_text())
            except json.JSONDecodeError:
                continue
            index[f.stem] = f
            index[data.get("name", f.stem)] = f
    return index


def flatten(name, index):
    if name not in index:
        sys.exit(f"Orca has no preset named '{name}'.")
    data = json.loads(index[name].read_text())
    parent = data.pop("inherits", None)
    merged = flatten(parent, index) if parent else {}
    merged.update(data)
    return merged


def write_profiles(job, force):
    presets = job.get("presets", {})
    overrides = job.get("overrides", {})
    for kind, out in job["profiles"].items():
        out = DATA / out
        if out.exists() and not force:
            print(f"Profile: {out.relative_to(DATA)}")
            continue
        if kind not in presets:
            sys.exit(f"No [presets] {kind} in the job to build {out.relative_to(DATA)} from.")
        data = flatten(presets[kind], preset_index(kind))
        data.update(overrides.get(kind, {}))
        data["name"] = presets[kind]
        data["from"] = "system"
        out.write_text(json.dumps(data, indent=4) + "\n")
        print(f"Wrote {out.relative_to(DATA)} from '{presets[kind]}'")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    ap.add_argument("--force", action="store_true", help="rebuild profiles that already exist")
    a = ap.parse_args()

    with open(a.job, "rb") as fh:
        job = tomllib.load(fh)

    install_orca()
    fetch_model(job)
    write_profiles(job, a.force)
    print(f"Ready: python scripts/run.py {a.job}")


if __name__ == "__main__":
    main()
