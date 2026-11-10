# 3d-prints

Models, slicer profiles, and scripts for printing on the Creality K2 Combo
(Moonraker at `192.168.4.42:7125`).

```
models/<name>/      downloaded .3mf/.stl + SOURCE.md (link, license)
profiles/           OrcaSlicer presets exported as JSON
jobs/<name>.toml    model + profiles + copy count
scripts/setup.py    install Orca, fetch the model, build profiles
scripts/k2.py       printer CLI (status, upload, print, watch, pause...)
scripts/run.py      slice a job with OrcaSlicer, then print it
app/                Print Bay: desktop/web app for the printer and the models
costs.toml          filament and power rates for the app's cost estimates
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

`profiles/k2-machine.json` purges 5 mm in from the bed's left and front
edges; Orca's stock K2 start G-code purges right on them, where the nozzle
snagged and the motors stalled. Keep that edit if you rebuild it with
`setup.py --force`.

Wood-fill spools (CR-Wood) slice with `profiles/k2-wood.json` in place of the
job's filament profile: Orca's "CR-Wood @K2 Plus-all" at 210 °C (215 °C first
layer), 10 mm³/s (walls slow to about 110 mm/s) and 1 mm retraction, so it
strings less. `run.py --material wood` writes `gcode/<job>-wood.gcode`; in the
app, the print panel's Material switch picks it, and it defaults to Wood when
the printer has the picked slot set to CR-Wood.

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
```

OpenSCAD models need `brew install --cask openscad@snapshot`; `run.py`
renders them to STL before slicing. A job's optional `[scad]` table overrides
the model's top-level variables (passed as `-D`), e.g. `rows = "2"`.

## Print Bay app

A Node/TypeScript app over the same files and printer: live camera and status,
pause/resume/cancel, the model library with 3D previews and toolpath x-ray,
OpenSCAD parameter editing with re-slicing, and printing with a copy queue
(each later copy waits for you to confirm the bed is clear).

```
cd app
npm install
npm run desktop     # build, then open the Electron app
npm start           # or just the server: http://localhost:8765 (also on the LAN)
npm run dev         # server with reload + Vite on :5173
```

`app/server` (Fastify) talks to Moonraker and this repo and shells out to
`scripts/run.py` for slicing; `app/web` is the React UI; `app/desktop` runs
the server inside Electron. Settings come from the environment: `K2_HOST`,
`PORT`, `BIND`, `OPENSCAD`, `PYTHON`.

### Claude

**Edit with Claude** (on an OpenSCAD model) and **New model** (in the Library)
chat with Claude Code through `claude -p`, using your existing Claude Code
login. Each message is one run, resumed with `--resume`, under
`--permission-mode dontAsk` with an allow list: an edit chat can only change
`models/<id>/` and its job file, and a new-model chat can only add to
`models/` and `jobs/`. Neither can slice, print, or run git. Every turn is
snapshotted under `.cache/app/agent/`, so **Undo last change** restores the
files exactly. New-model chats take photos (button, drag and drop, or paste).
Set `CLAUDE` if the CLI isn't at `~/.local/bin/claude`.

**Print checks** run on each model as it will be sliced: separate pieces,
build volume, overhangs past 45° (short flat bridges allowed; info only when
supports are on), walls under 1 mm, bed contact, warping and tipping. Run them
yourself with `node app/server/dist/check-cli.js <model>`. **Layout** in the
viewer shows the part laid out on the bed with a pin at each finding.
**Analyze and correct** has Claude review a model against its design rules
(the same brief the chats use, so new rules apply automatically) and the
checks, then fix what it can and note the review in `SOURCE.md`.

**Stress** colors the model by stress under a load: click where the weight
presses and what holds it (or let it auto-aim), pick kilograms and a material,
and it solves a voxel finite-element model in the browser (`npm test` checks
it against beam theory).

The K2 serves its camera over WebRTC on port 8000 and only connects when the
offer asks for a two-way (`sendrecv`) video channel. It seems to allow one
viewer at a time, so the app drops the connection when you leave the Printer
screen.
