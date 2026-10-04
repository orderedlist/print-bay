#!/usr/bin/env python3
"""
nurb_part.py - build a nurb part with changed parameters and write an STL.

Run with nurb's own Python (NURB_PYTHON, by default the nurb app's environment):

  "$NURB_PYTHON" scripts/nurb_part.py models/mini-tote-rack/parts/redesign.py out.stl rows=2 upright=True

A nurb part is a Python function whose keyword defaults are its parameters, so
`name=value` arguments (Python literals) override them. The function is the
one named like the file. `--params` prints the parameters as JSON instead:
name, default and the docstring's `name: description` line.
"""
import ast
import importlib.util
import inspect
import json
import sys
from pathlib import Path


def load(path):
    path = Path(path).resolve()
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    spec.loader.exec_module(module)
    fn = getattr(module, path.stem, None)
    if not callable(fn):
        sys.exit(f"{path.name} has no part function named {path.stem}")
    return fn


def params(fn):
    doc = inspect.getdoc(fn) or ""
    notes = {}
    for line in doc.splitlines():
        name, sep, text = line.strip().partition(":")
        if sep and name.isidentifier():
            notes[name] = text.strip()
    return [{"name": n, "default": repr(p.default), "comment": notes.get(n, "")}
            for n, p in inspect.signature(fn).parameters.items() if p.default is not inspect.Parameter.empty]


def main():
    args = sys.argv[1:]
    if len(args) == 2 and args[1] == "--params":
        print(json.dumps(params(load(args[0]))))
        return
    if len(args) < 2:
        sys.exit(__doc__)
    src, dest, *sets = args
    fn = load(src)
    overrides = {}
    for s in sets:
        name, _, value = s.partition("=")
        try:
            overrides[name] = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            sys.exit(f"{name}: {value!r} isn't a number, true/false or a quoted string")
    from build123d import export_stl
    export_stl(fn(**overrides), dest)


if __name__ == "__main__":
    main()
