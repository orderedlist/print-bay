# 3d-prints

Models, slicer profiles, and scripts for printing on the Creality K2 Combo
(Moonraker at `192.168.4.81:7125`).

```
models/<name>/      downloaded .3mf/.stl + SOURCE.md (link, license)
profiles/           OrcaSlicer presets exported as JSON
jobs/<name>.toml    model + profiles + copy count
scripts/setup.py    install Orca, fetch the model, build profiles
scripts/k2.py       printer CLI (status, upload, print, watch, pause...)
scripts/run.py      slice a job with OrcaSlicer, then print it
scripts/view.py     3D viewer for everything in models/ (localhost:8765)
viewer/             the viewer page
costs.toml          filament and power rates for the viewer's cost estimates
gcode/              sliced output (git-ignored)
```

## Setup

```
cd ~/dev/3d-prints
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/k2.py info
python scripts/setup.py jobs/stacking-box.toml
```

Needs Python 3.11+ (for `tomllib`) and OrcaSlicer. If Orca isn't in
`/Applications`, set `ORCA=/path/to/OrcaSlicer`.

## Profiles

`setup.py` builds the job's profile files from the Orca system presets named
in its `[presets]` table, flattening their `inherits` chains and applying
`[overrides]`. Re-run with `--force` after changing either.

Or set up the K2 printer, your PLA, and a process preset (0.2mm, 2 walls,
15% infill, supports on) in OrcaSlicer and save them as user presets.
Orca stores them as JSON in
`~/Library/Application Support/OrcaSlicer/user/default/{machine,process,filament}/`.
Copy them into `profiles/` with the names the job file uses.

## Adding a model

1. Make `models/<name>/`, drop in the file (.3mf, .stl, or .scad), add `SOURCE.md`.
2. Copy `jobs/stacking-box.toml` to `jobs/<name>.toml` and edit it.
   `python scripts/setup.py jobs/<name>.toml` fetches anything missing.
3. `python scripts/run.py jobs/<name>.toml --slice-only`, check the G-code
   in Orca's preview, then run without the flag to print.

## Everyday commands

```
python scripts/run.py jobs/stacking-box.toml       # slice + print all copies
python scripts/k2.py status
python scripts/k2.py watch
python scripts/k2.py cancel
python scripts/k2.py slots                         # filament loaded in the CFS
python scripts/view.py                             # browse models in 3D
```

In the viewer, **Toolpaths** shows a sliced job's G-code colored by feature
(walls, infill, skins, bridges, supports). **X-ray** fades the walls so the
infill shows through; **This layer only** looks straight down on one layer.

OpenSCAD models need `brew install --cask openscad@snapshot`; `run.py`
renders them to STL before slicing, and the viewer shows them upright.
