#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Keep the standalone retained editor's discovery policy identical to the app module."""
import sys
from pathlib import Path
from bundle import parse

ROOT = Path(__file__).resolve().parent
BEGIN, END = "/*DISCOVERY-BEGIN*/", "/*DISCOVERY-END*/"


def main():
    source = parse(ROOT / "app/src/discovery.js")
    if source["imports"]:
        raise SystemExit("discovery policy must use its injected protocol, without imports")
    path = ROOT / "editor.html"
    with path.open(encoding="utf-8", newline="") as stream:
        text = stream.read()
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise SystemExit("retained editor needs one discovery block")
    before, rest = text.split(BEGIN)
    _, after = rest.split(END)
    newline = "\r\n" if rest.startswith("\r\n") else "\n"
    body = source["body"].strip().replace("\n", newline)
    expected = before + BEGIN + newline + body + newline + END + after
    if "--check" in sys.argv:
        if expected != text:
            raise SystemExit("retained discovery is stale: run python3 gen_discovery.py")
    else:
        with path.open("w", encoding="utf-8", newline="") as stream:
            stream.write(expected)


if __name__ == "__main__":
    main()
