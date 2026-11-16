# Print Bay

Print Bay and the scripts for printing on the Creality K2 Combo (Moonraker at
`192.168.4.42:7125`). The models, jobs and plates live in a library of their
own, a separate private repo (here, `~/dev/3d-prints-library`; see Library
below), so this repo is just the app.

```
profiles/           OrcaSlicer presets exported as JSON: what a new library starts with
scripts/setup.py    install Orca, fetch the model, build profiles
scripts/k2.py       printer CLI (status, upload, print, watch, pause...)
scripts/run.py      slice a job (through scripts/slice), then print it
scripts/slice       Print Bay's slicer from the terminal (app/server/src/slicer.ts)
app/                Print Bay: desktop/web app for the printer and the models
costs.toml          default filament and power rates for a new library
```

In the library:

```
models/<name>/      downloaded .3mf/.stl/.scad + SOURCE.md (link, license)
jobs/<name>.toml    model + profiles + copy count
plates/<name>.toml  several jobs' parts printed at once
profiles/, costs.toml, gcode/ (sliced output, not committed)
```

## Setup

```
git clone https://github.com/orderedlist/print-bay.git
cd print-bay
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/k2.py info
python scripts/setup.py jobs/stacking-box.toml
```

Needs Python 3.11+ (for `tomllib`), OrcaSlicer, and the app built once
(`cd app && npm install && npm run build`): `run.py` slices with the app's
slicer. If Orca isn't in `/Applications`, set `ORCA=/path/to/OrcaSlicer`.

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
strings less. It leaves chamber control off: Orca's preset sends `M191 S35`,
and on the K2 (no chamber heater) that switches the exhaust fan on at full speed
once the chamber passes 35 °C, partway up the print, leaving a line around it.
`run.py --material wood` writes `gcode/<job>-wood.gcode`; in the
app, the print panel's Material switch picks it, and it defaults to Wood when
the printer has the picked slot set to CR-Wood.

Silk PLA works the same way with `profiles/k2-silk.json` (Orca's "Creality
Generic PLA Silk @K2-all"): the job's PLA with flow capped at 10 mm³/s, so the
walls print slower and keep their sheen. `--material silk` writes
`gcode/<job>-silk.gcode`, and the app picks Silk when the slot is set to
Generic PLA-Silk or CR-Silk.

Stone-filled PLA (marble, granite) uses `profiles/k2-stone.json`: the job's
PLA with a 60 °C bed and 225 °C nozzle for the first layer (55 °C after) so it
grips the textured plate, and flow capped at 12 mm³/s. Print it with a 0.6 mm
nozzle. Creality has no filament id for it, so pick **Stone** in the app (or
`--material stone`, which writes `gcode/<job>-stone.gcode`). A part whose first
layer is a thin ring on its own, like the succulent pots' bases, also wants a
brim in its job (`brim_type = "outer_only"`, `brim_width = "5"`).

For a 0.6 mm nozzle, `run.py --nozzle 0.6` slices with
`profiles/k2-machine-0.6.json` (Orca's "Creality K2 0.6 nozzle", with the same
purge-line edit) and lays `profiles/k2-nozzle-0.6.json` over the job's process:
the line widths and speeds of Orca's "0.30mm Standard @Creality K2 0.6 nozzle".
Layer heights stay the job's. It writes `gcode/<job>-0.6mm.gcode` (after any
`-wood`). The printer doesn't report a nozzle swap, so in the app set it under
Nozzle size in the printer panel; every slice and print follows it.

A plate (`plates/<name>.toml`) prints several parts of a downloaded 3MF at once:
Plant 3, Plant 6 and two funnels, say. On a multi-part model's page, **+ New
plate** makes one and the plate panel sets how many of each part it holds.
The slicer copies each part's object (with its fill_base and modifiers) into one
3MF, gives each object the process overrides it doesn't share with the others,
and has Orca arrange them on the bed. Parts in different colours get a filament
each, but swap spools every layer, so a plate per colour is usually much faster.
Pick the same spool for every part (the outside spool, say) and it slices as one
colour with no swaps (`run.py --one-color`, `gcode/<job>-1c.gcode`); this works for
multi-colour OpenSCAD jobs too.

## Adding a model

In the library:

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

`app/server` (Fastify) talks to Moonraker and the library and slices with
OrcaSlicer's CLI (`slicer.ts`: rendering, materials, nozzles, plates, base
fills, one-colour slices), so the app needs no Python. It's the only slicer:
`scripts/slice` runs it from the terminal and `run.py` slices through that, so
changes to how jobs slice go in `slicer.ts`. `app/web` is the React UI;
`app/desktop` runs the server inside Electron.

### Building the Mac app

```
cd app
npm run dist            # signed Print Bay.app, .dmg and .zip in desktop/release/
npm run dist:notarize   # the same, notarized so it opens on other Macs without a warning
```

`desktop/bundle.mjs` stages what the app carries: the server and the checks
CLI bundled with esbuild, the built UI, `scripts/check`, `scripts/nurb` and
`nurb_part.py`, the K2 profiles and default rates. No models, jobs or slices.
The app runs its own binary as Node for `scripts/check`, and links Claude's
tools from `~/Library/Caches/PrintBay/bin` because their real path has a space.

Signing uses the "Developer ID Application" certificate in your keychain.
Notarizing also needs Apple credentials in the environment, for example
`APPLE_KEYCHAIN_PROFILE` (a profile made with `xcrun notarytool
store-credentials`), or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. The build is Apple silicon only. People who install it
still need OrcaSlicer, and Claude Code, OpenSCAD and Git for those features.

### Setup and Settings

A new library opens on **Set up Print Bay**, which is **Settings** (the gear)
from then on:
- **Printer:** **Scan network** finds printers by asking every address on the
  Mac's local network for Moonraker (port 7125; a few seconds), K2s first,
  and runs by itself while no printer is set. Or type the address and Test
  it. The K2 doesn't advertise itself over Bonjour, so give it a fixed
  address in your router.
- **Library:** where it is. While it's empty, you can give the remote of a
  library pushed from another computer and it copies that instead.
- **Programs:** OrcaSlicer (needed to slice), plus OpenSCAD, Claude Code, Git
  and nurb (optional). Each is found
  in the usual places or set by path, with install hints for what's missing.
  Without Claude Code the Claude features hide; without Git, Changes hides.
- **Costs:** the rates in `costs.toml`.

The printer and program paths belong to each computer, so they're kept in the
library's `settings.json`, which git never commits. Environment variables
still win: `K2_HOST`, `ORCA`, `OPENSCAD`, `CLAUDE`, `GIT`,
`NURB_PYTHON`, plus `PORT`, `BIND` and `PRINT_BAY_DATA`. A checkout that is
its own library (like this repo) skips setup and keeps its old printer
address (192.168.4.42). Only the computer running Print Bay can change settings.

### Library

The app keeps each person's models, jobs, profiles, G-code, `costs.toml` and
cache in a library folder, apart from its code. Which folder, in order:
1. `PRINT_BAY_DATA`, if set.
2. The folder chosen in **Settings → Library → Use another folder…**, saved in
   `~/Library/Application Support/Print Bay/library-location`. The desktop app
   restarts into it; an empty or new folder becomes a new library.
3. This checkout, while it has its own `jobs/`.
4. `~/Library/Application Support/Print Bay/Library`, which starts empty with
   the K2 profiles from `profiles/` and the rates from `costs.toml`.

`run.py`, `setup.py` and `scripts/nurb` find it the same way, so the terminal
scripts follow the app. The app passes it on to Claude's tools, and Claude
chats run inside the library.

### Changes (git)

The library and the app's code are each a git repo, and the **Changes** tab
commits and pushes them. A new library becomes a repo on first run, ignoring
`gcode/` and `.cache/`. Commit takes everything that changed (`git add -A`),
with a suggested message like "Update tote-rack". Push uses your own git
sign-in (SSH key or credential helper) and never prompts, so push once from a
terminal if it can't sign in. Without a remote, the tab asks for one, and only
the computer running Print Bay can set it. In a checkout that is its own
library, the library and the app are one repo.

**Pull** rebases your commits onto the remote's and keeps uncommitted edits.
It won't start if you've edited a file the pull changes (commit first), and if
your commits and the remote's change the same lines it backs out with nothing
changed, for you to merge in a terminal. The tab fetches while it's open, at
most once a minute, so it can show what's waiting. Commit and Pull wait while
Claude is editing. A pull that changes `app/` takes effect after a restart;
changes to `scripts/` apply at once.

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
