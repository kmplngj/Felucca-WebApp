#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Host contract and mock-browser gate; also runs locally without npm dependencies."""
import argparse
import functools
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
PROBE_TIMEOUT = 30
LOCKED_RUNNER_TIMEOUT = 18 * 60
PACKAGE_SKIP = "packages: skipped (needs FM-1_v15.fwsc and a felucca/build.py build)"
OTA_STOCK_SKIP = "updater: official V15 success: skipped (set FELUCCA_STOCK to the unmodified official file)"
CLASSIC_SKIPS = {
    "editor: MENU settings (this editor has none)",
    "FM6 bank: (editor.html has no voice bank sender)",
    "MIDI LEARN: (editor.html has no learn map)",
    "CUSTOM palette: (editor.html has none)",
}
FIRMWARE_IDENTITY_ENV = {
    "GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA",
    "FELUCCA_VERIFIED_PR", "FELUCCA_VERIFIED_COMMIT",
}


def owned_run(command, *, timeout, **kwargs):
    if os.name != "posix":
        raise RuntimeError("the CI runner requires macOS/Linux POSIX process groups")
    # All uv/locked-runner descendants inherit this group, including stage subprocesses.
    # Clean up before the parent reads/writes the summary, even if the group leader exited first.
    with subprocess.Popen(command, start_new_session=True, **kwargs) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def output(*cmd, cwd=ROOT):
    if "--inside-locked-env" in sys.argv:
        # Stay in the parent's owned group; its cleanup also stops any descendants of a failed probe.
        return subprocess.check_output(cmd, cwd=cwd, text=True, timeout=PROBE_TIMEOUT).rstrip()
    done = owned_run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, timeout=PROBE_TIMEOUT)
    done.check_returncode()
    return done.stdout.rstrip()


def unexpected_skips(text, suite, *, stock_requested=False):
    skips = [line.strip() for line in text.splitlines()
             if line.rstrip().endswith(" skip") or ": skipped (" in line or re.match(r"(?i)\s*skip\b", line)]
    allowed = {PACKAGE_SKIP} if suite in ("classic", "app-protocol") else set()
    if suite == "ota" and not stock_requested:
        allowed.add(OTA_STOCK_SKIP)
    return skips, [line for line in skips if line not in allowed and not (
        suite == "classic" and line.removesuffix("skip").strip() in CLASSIC_SKIPS)]


def firmware_pin(override):
    pin = json.loads((ROOT / "ci/firmware.json").read_text())
    if not isinstance(pin, dict) or pin.get("repository") != "kmplngj/Felucca":
        raise ValueError("firmware pin must identify kmplngj/Felucca")
    revision = override or pin.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("firmware revision must be a full lowercase commit SHA")
    return pin, revision


def firmware_environment(client_env):
    # build_identity.py must resolve the pinned firmware's Git identity, not the consumer PR's.
    # Keep job infrastructure (including step-summary/output paths) and client context outside these commands.
    return {key: value for key, value in client_env.items() if key not in FIRMWARE_IDENTITY_ENV}


def browser_tests(directory, stage, env, results):
    chrome = env.get("CHROME_BIN") or next((p for p in (
        shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chromium-browser"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ) if p and Path(p).is_file()), None)
    if not chrome:
        raise RuntimeError("Chrome/Chromium is required; install it or set CHROME_BIN")
    results["browser"] = output(chrome, "--version")
    spec = importlib.util.spec_from_file_location("webapp_serve", ROOT / "serve.py")
    serve = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(serve)

    class QuietHandler(serve.NoCache):
        def log_message(self, *_args):
            pass

    server = serve.Server(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        stage("browser-driver", ["node", str(ROOT / "ci/test_browser.mjs"), chrome,
                                 f"http://127.0.0.1:{server.server_port}"], timeout=90)
        fixtures = sorted((ROOT / "test_fixtures/menu").glob("*.html"))
        if not fixtures:
            raise RuntimeError("No browser fixtures found")
        for fixture in fixtures:
            name = "browser-" + fixture.stem
            with tempfile.TemporaryDirectory(prefix="felucca-chrome-") as profile:
                command = ["node", str(ROOT / "ci/browser.mjs"), chrome,
                           f"http://127.0.0.1:{server.server_port}/{fixture.relative_to(ROOT).as_posix()}", profile]
                stage(name, command, timeout=90)
            dom = (directory / (name + ".log")).read_text()
            match = re.search(r'<p\b[^>]*\bid="result"[^>]*>(.*?)</p>', dom, re.S)
            result = html.unescape(re.sub(r"<[^>]+>", "", match[1])) if match else "No result element"
            if not result.startswith("PASS:"):
                raise RuntimeError(f"{name}: {result}; see {directory / (name + '.log')}")
            results["checks"][-1]["result"] = result
            print(f"{name}: {result}", flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firmware", type=Path, default=ROOT.parent / "Felucca")
    parser.add_argument("--firmware-revision",
                        help="Exact test-only override; normal CI uses ci/firmware.json")
    parser.add_argument("--print-firmware-revision", action="store_true")
    parser.add_argument("--inside-locked-env", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.print_firmware_revision:
        try:
            _pin, revision = firmware_pin(args.firmware_revision)
        except (OSError, ValueError) as error:
            parser.error(str(error))
        print(revision)
        return 0
    directory = ROOT / "build/ci"
    directory.mkdir(parents=True, exist_ok=True)
    # Invalidate a previous green result before pin/checkout/tool preflight can fail.
    results = {"status": "running", "checks": []}
    (directory / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    try:
        pin, revision = firmware_pin(args.firmware_revision)
        results.update(firmware_repository=pin["repository"], firmware_revision=revision)
        firmware = args.firmware.resolve()
        if output("git", "rev-parse", "HEAD", cwd=firmware) != revision:
            raise RuntimeError(f"firmware checkout must be exactly {revision}")
        if output("git", "status", "--porcelain", "--untracked-files=no", cwd=firmware):
            raise RuntimeError("firmware tracked sources/submodules must be clean")
        submodules = output("git", "submodule", "status", "--recursive", cwd=firmware)
        if any(line.startswith(("-", "+", "U")) for line in submodules.splitlines()):
            raise RuntimeError("initialize firmware submodules at their pinned commits")
        env = {k: v for k, v in os.environ.items() if not k.startswith("FELUCCA_")}
        # Optional proprietary input is explicit, unlike generated contract inputs supplied below.
        # Preserve it across the locked runner; missing/invalid requested files must fail the OTA suite.
        if stock := os.environ.get("FELUCCA_STOCK"):
            env["FELUCCA_STOCK"] = str(Path(stock).resolve())
        env.update(PYTHONDONTWRITEBYTECODE="1", FELUCCA_PROFILE="standard", FELUCCA_FONT="m8stealth")
        if not args.inside_locked_env:
            done = owned_run(["uv", "run", "--project", str(firmware), "--locked", "--group", "build",
                              "python", str(Path(__file__).resolve()), *sys.argv[1:], "--inside-locked-env"],
                             cwd=ROOT, env=env, timeout=LOCKED_RUNNER_TIMEOUT).returncode
            child = json.loads((directory / "summary.json").read_text())
            if done or child.get("status") != "passed":
                results = child
                raise RuntimeError(f"locked runner exited {done}: {child.get('error', 'no completed passing summary')}")
            return 0
        fixtures = firmware / "build/host/webapp-ci"
        fixtures.mkdir(parents=True, exist_ok=True)
        cc = shlex.split(env.get("CC", "cc"))
        results.update({"firmware_override": revision != pin["revision"], "submodules": submodules,
                        "client_revision": output("git", "rev-parse", "HEAD"),
                        "client_dirty": output("git", "status", "--porcelain"), "node": output("node", "--version"),
                        "python": sys.version, "uv": output("uv", "--version"),
                        "cc": output(*cc, "--version").splitlines()[0], "profile": "standard"})
        # Include tool/revision provenance once the locked environment is ready.
        (directory / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        results.update(status="failed", error=str(error))
        (directory / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        print(error, file=sys.stderr)
        return 1
    def stage(name, command, *, cwd=ROOT, timeout=600, stdout=None, command_env=None):
        start = time.monotonic()
        log_path = directory / (name + ".log")
        process_env = env if command_env is None else command_env
        with log_path.open("w") as log:
            if stdout:
                with stdout.open("w") as target:
                    done = subprocess.run(command, cwd=cwd, env=process_env, stdout=target, stderr=log, timeout=timeout)
            else:
                done = subprocess.run(command, cwd=cwd, env=process_env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        text = log_path.read_text()
        skips, unexpected = unexpected_skips(text, name, stock_requested=bool(env.get("FELUCCA_STOCK")))
        results["checks"].append({"name": name, "command": command, "cwd": str(cwd), "exit": done.returncode,
                                  "seconds": round(time.monotonic() - start, 2),
                                  "skips": skips, "log": log_path.name})
        if done.returncode or unexpected:
            raise RuntimeError(f"{name}: exit {done.returncode}, unexpected skips {unexpected}; see {log_path}")
        print(f"{name}: PASS" + (f" ({len(skips)} documented skips)" if skips else ""), flush=True)

    try:
        stage("runner-regressions", [sys.executable, "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py", "-v"],
              command_env={**env, "FELUCCA_TEST_FIRMWARE": str(firmware), "FELUCCA_TEST_FIRMWARE_REVISION": revision})
        firmware_env = firmware_environment(env)
        stage("generate", [sys.executable, "-c", "import sys; sys.path.insert(0, 'tools'); import build; build.generate()"],
              cwd=firmware, command_env=firmware_env)
        # Match tests/run_tests.sh host CC and fixture commands. GCC needs -O1 to discard unused target HAL paths.
        flags = ["-O1", "-Wall", "-Wno-unused-function", "-w", "-Ibuild/gen", "-Ifirmware/src"]
        stage("compile-descriptors", [*cc, *flags, "tests/descdump.c", "-lm", "-o", str(fixtures / "descdump")],
              cwd=firmware, command_env=firmware_env)
        for name, extra in [("desc", []), ("desc-legacy-web", ["--legacy-web-mock"])]:
            stage(name, [str(fixtures / "descdump"), *extra], stdout=fixtures / (name + ".json"), command_env=firmware_env)
        for name, extra in [("menu", []), ("menu-nocpu2", ["-DFELUCCA_CPU2=0"])]:
            binary = fixtures / name
            stage("compile-" + name, [*cc, *flags, *extra, "tests/editor_test.c", "-lm", "-o", str(binary)],
                  cwd=firmware, command_env=firmware_env)
            stage(name, [str(binary)], cwd=firmware,
                  command_env={**firmware_env, "MENU_JSON": str(fixtures / (name + ".json"))})
        results["fixtures"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(fixtures.glob("*.json"))}
        env.update(FELUCCA_DESC=str(fixtures / "desc-legacy-web.json"), FELUCCA_TOOLS=str(firmware / "tools"),
                   FELUCCA_ROOT=str(firmware), FELUCCA_FIRMWARE=str(firmware),
                   FELUCCA_PALETTES=str(firmware / "tools/gen_ui_palettes.py"),
                   FELUCCA_INTERTIGHT=str(firmware / "assets/fonts/InterTight[wght].ttf"),
                   FELUCCA_MENU=str(fixtures / "menu.json"), FELUCCA_MENU_NOCPU2=str(fixtures / "menu-nocpu2.json"))
        for name, command in [
            ("classic", ["node", "test_web.mjs"]),
            ("app-protocol", ["env", "FELUCCA_PROTO=app", "node", "test_web.mjs"]),
            ("ota", ["node", "test_ota.mjs"]),
            ("backup", ["node", "test_backup.mjs"]),
            ("settings", ["node", "test_settings.mjs"]),
            ("app", ["node", "test_app.mjs"]),
            ("catalog", ["node", "test_catalog.mjs"]),
            ("legacy", ["node", "test_legacy.mjs"]),
        ]:
            stage(name, command)
        browser_tests(directory, stage, env, results)
        results["status"] = "passed"
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        results["status"] = "failed"
        results["error"] = str(error)
        print(error, file=sys.stderr)
    finally:
        (directory / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        summary = (f"WebApp CI: **{results['status']}**\n\nFirmware: `{revision}`"
                   + (" (test-only override)" if results["firmware_override"] else " (recorded pin)") + "\n\n"
                   + "\n".join(f"- {c['name']}: exit {c['exit']}; skips {len(c['skips'])}" for c in results["checks"]))
        for check in results["checks"]:
            for skipped in check["skips"]:
                summary += f"\n  - {check['name']}: {skipped}"
        if "error" in results:
            summary += f"\n\nFailure: {results['error']}"
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as target:
                target.write(summary + "\n")
        print(f"{results['status']}: {directory / 'summary.json'}", flush=True)
    return 0 if results["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
