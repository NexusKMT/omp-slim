#!/usr/bin/env python3
"""Measure native edit/build/run feedback on the public macOS Actions runner."""

import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "crates/pi-natives/src/text.rs"
ANCHOR = "width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH) as usize"
PROFILE = os.environ.get("OMP_NATIVE_CARGO_PROFILE", "")
RECORD = ROOT / "dist/validation/development-benchmark" / PROFILE


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def command(label, argv):
    started = time.perf_counter()
    print(f"::group::{PROFILE}: {label}", flush=True)
    with (RECORD / f"{label}.log").open("w") as log:
        process = subprocess.Popen(
            argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                print(line, end="", flush=True)
            status = process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    result = {"label": label, "command": argv, "seconds": round(time.perf_counter() - started, 3), "exit_code": status}
    write_json(RECORD / f"{label}.json", result)
    print("::endgroup::", flush=True)
    print(json.dumps(result), flush=True)
    if status:
        raise RuntimeError(f"{label} failed with exit code {status}")
    return result


def build(label):
    timing_dir = Path(os.environ["CARGO_TARGET_DIR"]) / "cargo-timings"
    before = set(timing_dir.glob("cargo-timing-*.html"))
    result = command(label, ["bun", "run", "build:native"])
    reports = sorted(set(timing_dir.glob("cargo-timing-*.html")) - before)
    if len(reports) != 1:
        raise RuntimeError(f"Expected one fresh Cargo timing report for {label}, got {reports}")
    html = reports[0].read_text()
    match = re.search(r"const UNIT_DATA\s*=\s*", html)
    if not match:
        raise RuntimeError("Cargo timing report has no unit data")
    units, _ = json.JSONDecoder().raw_decode(html[match.end():])
    result["cargo_units"] = len(units)
    result["cargo_seconds"] = round(max((u["start"] + u["duration"] for u in units), default=0), 3)
    result["units"] = units
    (RECORD / f"{label}-cargo.html").write_text(html)
    write_json(RECORD / f"{label}.json", result)
    return result


def probe(label, expected):
    # A separate Bun process reloads the newly installed addon on every sample.
    return command(label, [
        "bun", "-e",
        'import { visibleWidth } from "./packages/natives/native/index.js"; '
        'const expected = Number(process.argv[1]); '
        'const actual = visibleWidth("\\t", 100); '
        'if (actual !== expected) throw new Error(`Expected tab width ${expected}, received ${actual}`); '
        'console.log(JSON.stringify({ expected, actual }));',
        str(expected),
    ])


def smoke(label):
    return command(label, ["bun", "run", "dev", "--smoke-test"])


def warm():
    original = SOURCE.read_bytes()
    write_json(RECORD / "provenance.json", {
        "source_commit": os.environ["GITHUB_SHA"],
        "profile": PROFILE,
        "target": os.environ["CARGO_BUILD_TARGET"],
        "rustflags": os.environ["RUSTFLAGS"],
        "cache_key": os.environ.get("OMP_DEVELOPMENT_CACHE_KEY"),
        "restored_cache_key": os.environ.get("OMP_DEVELOPMENT_RESTORED_CACHE_KEY"),
        "source_sha256": hashlib.sha256(original).hexdigest(),
        "sample_kind": "change the existing tab-width clamp function; verify the loaded addon returns the new limit",
        "scope": "native function-body edits in one retained checkout; excludes cross-job cache restore latency",
    })
    (RECORD / "original-text.rs").write_bytes(original)
    build("warm-build")
    probe("warm-probe", 16)
    smoke("warm-smoke")
    build("unchanged-build")
    probe("unchanged-probe", 16)


def edits():
    original = (RECORD / "original-text.rs").read_bytes()
    if SOURCE.read_bytes() != original:
        raise RuntimeError("Source changed after warmup")
    text = original.decode()
    samples = []
    current = original
    try:
        for index in range(1, 4):
            started = time.perf_counter()
            changed = text.replace(ANCHOR, f"width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH + {index}) as usize")
            current = changed.encode()
            SOURCE.write_bytes(current)
            (RECORD / f"edit-{index}.patch").write_text(
                f"--- crates/pi-natives/src/text.rs\n+++ crates/pi-natives/src/text.rs\n"
                f"@@\n-\t{ANCHOR}\n+\twidth.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH + {index}) as usize\n"
            )
            compiled = build(f"edit-{index}-build")
            observed = probe(f"edit-{index}-probe", 16 + index)
            checked = smoke(f"edit-{index}-smoke")
            sample = {
                "index": index, "expected_tab_width": 16 + index,
                "build_install_seconds": compiled["seconds"],
                "cargo_seconds": compiled["cargo_seconds"],
                "cargo_units": compiled["cargo_units"],
                "probe_seconds": observed["seconds"],
                "source_smoke_seconds": checked["seconds"],
                "edit_to_verified_seconds": round(time.perf_counter() - started, 3),
            }
            samples.append(sample)
            write_json(RECORD / "samples.json", samples)
            print("EDIT_RESULT " + json.dumps(sample), flush=True)
    finally:
        if SOURCE.read_bytes() != current:
            raise RuntimeError("Source changed concurrently; refusing to overwrite it")
        SOURCE.write_bytes(original)
        write_json(RECORD / "source-restoration.json", {
            "restored": SOURCE.read_bytes() == original,
            "sha256": hashlib.sha256(original).hexdigest(),
        })


def restore():
    original = (RECORD / "original-text.rs").read_bytes()
    if SOURCE.read_bytes() != original:
        raise RuntimeError("Benchmark source was not restored")
    build("restored-build")
    probe("restored-probe", 16)
    smoke("restored-smoke")
    command("native-exports", ["bun", "scripts/slim/verify-native.ts"])
    command("pty-shell-tests", [
        "bun", "test", "packages/natives/test/native.test.ts",
        "--test-name-pattern", r"\b(pty|shell)\b", "--timeout", "40000",
    ])
    command("grammar-tests", [
        "bun", "test", "packages/natives/test/parse-status.test.ts",
        "packages/coding-agent/test/utils/grammars.test.ts", "--timeout", "40000",
    ])
    command("shell-session-tests", [
        "bun", "test", "packages/coding-agent/test/bash-session-state.test.ts", "--timeout", "40000",
    ])
    addons = list((ROOT / "packages/natives/native").glob("pi_natives.darwin-x64*.node"))
    if len(addons) != 1:
        raise RuntimeError(f"Expected one restored addon, got {addons}")
    addon = addons[0]
    write_json(RECORD / "validated-addon.json", {
        "file": addon.name, "size": addon.stat().st_size,
        "sha256": hashlib.sha256(addon.read_bytes()).hexdigest(),
        "source_commit": os.environ["GITHUB_SHA"], "profile": PROFILE,
        "source_restored": True,
    })


def summarize():
    samples_file = RECORD / "samples.json"
    samples = json.loads(samples_file.read_text()) if samples_file.exists() else []
    summary = {"profile": PROFILE, "source": os.environ["GITHUB_SHA"], "samples": samples}
    if samples:
        for field in ["build_install_seconds", "cargo_seconds", "edit_to_verified_seconds"]:
            summary["median_" + field] = statistics.median(row[field] for row in samples)
    for label in ["warm-build", "unchanged-build", "restored-build", "source-restoration", "validated-addon"]:
        file = RECORD / f"{label}.json"
        if file.exists():
            summary[label] = {k: v for k, v in json.loads(file.read_text()).items() if k != "units"}
    write_json(RECORD / "summary.json", summary)
    rendered = "```json\n" + json.dumps(summary, indent=2) + "\n```\n"
    print(rendered, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as file:
            file.write(rendered)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    if action == "inspect":
        text = SOURCE.read_text()
        if text.count(ANCHOR) != 1:
            raise RuntimeError("Expected exactly one existing tab-width clamp")
        print("Native function mutation anchor verified; no source was changed or compiled.")
    else:
        if action not in {"warm", "edits", "restore", "summarize"}:
            raise SystemExit("Usage: benchmark-development.py inspect|warm|edits|restore|summarize")
        if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "NexusKMT/omp-slim":
            raise SystemExit("Native benchmark builds run only in the public OMP Slim Actions workflow")
        if PROFILE not in {"dev", "local"}:
            raise SystemExit("Choose OMP_NATIVE_CARGO_PROFILE=dev or local")
        RECORD.mkdir(parents=True, exist_ok=True)
        if SOURCE.read_text().count(ANCHOR) != 1 and action in {"warm", "edits"}:
            raise RuntimeError("Expected exactly one existing tab-width clamp")
        {"warm": warm, "edits": edits, "restore": restore, "summarize": summarize}[action]()
