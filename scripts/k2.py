#!/usr/bin/env python3
"""
k2.py - Tiny Moonraker CLI for a Creality K2.

Usage:
  python k2.py info                      # firmware / Klipper state
  python k2.py status                    # temps + print progress
  python k2.py ls                        # list G-code files on the printer
  python k2.py slots                     # filament loaded in the CFS
  python k2.py upload part.gcode         # upload only
  python k2.py print part.gcode          # upload + start
  python k2.py start part.gcode          # start a file already on the printer
  python k2.py watch                     # live progress until the print ends
  python k2.py gcode "G28"               # send raw G-code
  python k2.py pause | resume | cancel

Requires: pip install requests
Override host with K2_HOST env var, e.g. K2_HOST=192.168.4.42:7125
"""
import os
import sys
import time
import argparse
from pathlib import Path

import requests

HOST = os.environ.get("K2_HOST", "192.168.4.42:7125")
BASE = f"http://{HOST}"
TIMEOUT = 10


def api(method, path, **kw):
    kw.setdefault("timeout", TIMEOUT)
    r = requests.request(method, f"{BASE}{path}", **kw)
    r.raise_for_status()
    return r.json().get("result", r.json())


def cmd_info(_):
    info = api("GET", "/printer/info")
    print(f"State:    {info.get('state')}  ({info.get('state_message', '').strip()})")
    print(f"Klipper:  {info.get('software_version')}")
    print(f"Hostname: {info.get('hostname')}")


def get_status():
    q = "print_stats&extruder&heater_bed&display_status&virtual_sdcard"
    return api("GET", f"/printer/objects/query?{q}")["status"]


def fmt_status(s):
    ps = s.get("print_stats", {})
    ex = s.get("extruder", {})
    bed = s.get("heater_bed", {})
    prog = s.get("display_status", {}).get("progress") \
        or s.get("virtual_sdcard", {}).get("progress", 0)
    elapsed = int(ps.get("print_duration", 0))
    eta = ""
    if prog and prog > 0.01 and elapsed:
        remaining = int(elapsed / prog - elapsed)
        eta = f"  ETA ~{remaining // 3600}h{(remaining % 3600) // 60:02d}m"
    return (
        f"[{ps.get('state', '?'):>9}] {prog * 100:5.1f}%  "
        f"nozzle {ex.get('temperature', 0):.0f}/{ex.get('target', 0):.0f}C  "
        f"bed {bed.get('temperature', 0):.0f}/{bed.get('target', 0):.0f}C  "
        f"{ps.get('filename', '') or '-'}{eta}"
    )


def cmd_status(_):
    print(fmt_status(get_status()))


def cmd_ls(_):
    files = api("GET", "/server/files/list?root=gcodes")
    for f in sorted(files, key=lambda f: f.get("modified", 0), reverse=True):
        mb = f.get("size", 0) / 1e6
        print(f"{mb:7.1f} MB  {f['path']}")


def slots():
    """Loaded CFS slots as dicts. G-code tool T<n> pulls from slot n (T1A=T0 ... T4D=T15)."""
    box = api("GET", "/printer/objects/query?box")["status"]["box"]
    found = []
    for unit in range(1, 5):
        u = box.get(f"T{unit}", {})
        if u.get("state") != "connect":
            continue
        for i, letter in enumerate("ABCD"):
            color = str(u["color_value"][i])
            if color == "-1":
                continue
            found.append({
                "slot": f"T{unit}{letter}",
                "tool": (unit - 1) * 4 + i,
                "color": "#" + color[-6:].upper(),
                "remain": int(u["remain_len"][i]),
            })
    return found


def cmd_slots(_):
    for s in slots():
        print(f"{s['slot']}  T{s['tool']:<2}  {s['color']}  {s['remain']:3d}% left")


def upload(path, start=False):
    p = Path(path)
    if not p.is_file():
        sys.exit(f"File not found: {p}")
    with p.open("rb") as fh:
        data = {"root": "gcodes"}
        if start:
            data["print"] = "true"
        res = api("POST", "/server/files/upload",
                  files={"file": (p.name, fh)}, data=data, timeout=300)
    print(f"Uploaded {p.name}" + (" and started print" if start else ""))
    return res


def cmd_upload(a):
    upload(a.file)


def cmd_print(a):
    upload(a.file, start=True)


def cmd_start(a):
    api("POST", "/printer/print/start", params={"filename": Path(a.file).name})
    print(f"Started {a.file}")


def cmd_watch(a):
    try:
        while True:
            s = get_status()
            print("\r" + fmt_status(s).ljust(110), end="", flush=True)
            if s.get("print_stats", {}).get("state") in ("complete", "cancelled", "error", "standby"):
                print()
                break
            time.sleep(a.interval)
    except KeyboardInterrupt:
        print()


def cmd_gcode(a):
    api("POST", "/printer/gcode/script", params={"script": a.script}, timeout=120)
    print("ok")


def simple(action):
    def run(_):
        api("POST", f"/printer/print/{action}")
        print(f"{action} sent")
    return run


def main():
    ap = argparse.ArgumentParser(description="Moonraker CLI for Creality K2")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info").set_defaults(fn=cmd_info)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("ls").set_defaults(fn=cmd_ls)
    sub.add_parser("slots").set_defaults(fn=cmd_slots)
    for name, fn in (("upload", cmd_upload), ("print", cmd_print), ("start", cmd_start)):
        p = sub.add_parser(name)
        p.add_argument("file")
        p.set_defaults(fn=fn)
    w = sub.add_parser("watch")
    w.add_argument("-i", "--interval", type=float, default=5)
    w.set_defaults(fn=cmd_watch)
    g = sub.add_parser("gcode")
    g.add_argument("script")
    g.set_defaults(fn=cmd_gcode)
    for action in ("pause", "resume", "cancel"):
        sub.add_parser(action).set_defaults(fn=simple(action))

    args = ap.parse_args()
    try:
        args.fn(args)
    except requests.ConnectionError:
        sys.exit(f"Can't reach Moonraker at {BASE}. Is the printer on and the IP right?")
    except requests.HTTPError as e:
        sys.exit(f"HTTP {e.response.status_code}: {e.response.text[:300]}")


if __name__ == "__main__":
    main()
