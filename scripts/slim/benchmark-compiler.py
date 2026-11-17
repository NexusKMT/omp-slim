#!/usr/bin/env python3
"""Compare native, builtin and shell edits from retained compiler checkpoints."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
THREADS = int(os.environ.get("OMP_FRONTEND_THREADS", "1"))
RECORD = ROOT / "dist/validation/compiler-matrix" / f"frontend-{THREADS}"
spec = importlib.util.spec_from_file_location("development_benchmark", Path(__file__).with_name("benchmark-development.py"))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
bench.RECORD = RECORD
CASES = {
    "native": {
        "path": "crates/pi-natives/src/text.rs",
        "anchor": "width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH) as usize",
        "changed": lambda n: f"width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH + {n}) as usize",
    },
    "builtins": {
        "path": "crates/pi-builtins/src/dirname.rs",
        "anchor": 'if path_bytes.is_empty() {\n\t\treturn Cow::Borrowed(b".");\n\t}',
        "changed": lambda n: f'if path_bytes.is_empty() {{\n\t\treturn Cow::Borrowed(b"./omp-bench-{n}");\n\t}}',
    },
    "shell": {
        "path": "crates/pi-shell/src/bash/vm/arith.rs",
        "anchor": 'return self.fail("expression recursion level exceeded");',
        "changed": lambda n: f'return self.fail("expression recursion level exceeded [omp-bench-{n}]");',
    },
}


def build(label):
    os.environ["OMP_DIAGNOSTIC_DIR"] = str(RECORD / label / "rustc")
    result = bench.build(label)
    result["rustc"] = [json.loads(p.read_text()) for p in sorted(Path(os.environ["OMP_DIAGNOSTIC_DIR"]).glob("*.json"))]
    bench.write_json(RECORD / f"{label}.json", result)
    return result


def probe(label, case, index=0):
    if case == "native":
        return bench.probe(label, 16 + index)
    expected = (f"./omp-bench-{index}\n" if index else ".\n") if case == "builtins" else (
        f"expression recursion level exceeded [omp-bench-{index}]" if index else "expression recursion level exceeded"
    )
    command = "dirname ''" if case == "builtins" else 'printf "%s" "$(( ' + "(" * 300 + "1" + ")" * 300 + ' ))"'
    return bench.command(label, ["bun", "-e", (
        'import { Shell } from "./packages/natives/native/index.js"; '
        'const shell=new Shell(); let output=""; '
        'const result=await shell.run({command:process.argv[1],timeoutMs:5000},(error,text)=>{if(error)throw error;output+=text}); '
        'const expected=process.argv[2]; const kind=process.argv[3]; '
        'if(result.cancelled||result.timedOut||(kind==="builtins" ? result.exitCode!==0||output!==expected : result.exitCode===0||!output.includes(expected))) '
        'throw new Error(JSON.stringify({result,output,expected})); '
        'await shell.abort(); console.log(JSON.stringify({result,output,expected}));'
    ), command, expected, case])


def tracked_files():
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    for raw in output.split(b"\0"):
        if not raw:
            continue
        name = os.fsdecode(raw)
        path = ROOT / name
        if path.is_file() and not path.is_symlink():
            yield name, path


def checkpoint_path():
    return Path(os.environ["CARGO_TARGET_DIR"]) / "omp-source-checkpoint.json"


def wrapper_digest():
    return hashlib.sha256((ROOT / "scripts/slim/rustc-diagnostics.py").read_bytes()).hexdigest()


def restore_timestamps():
    checkpoint = checkpoint_path()
    restored = 0
    compatible = False
    if checkpoint.exists():
        saved = json.loads(checkpoint.read_text())
        if saved["frontend_threads"] != THREADS:
            raise RuntimeError("Checkpoint frontend settings do not match")
        compatible = saved.get("wrapper_sha256") == wrapper_digest()
        for name, path in tracked_files():
            item = saved["files"].get(name)
            if item and hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]:
                os.utime(path, ns=(path.stat().st_atime_ns, item["mtime_ns"]))
                restored += 1
    bench.write_json(RECORD / "checkpoint-restoration.json", {
        "checkpoint_found": checkpoint.exists(), "identical_files_restored": restored,
        "instrumentation_matches": compatible,
        "rule": "restore an original timestamp only when the current tracked file SHA-256 matches the compiled checkpoint",
    })
    return compatible


def save_checkpoint():
    files = {}
    for name, path in tracked_files():
        files[name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mtime_ns": path.stat().st_mtime_ns}
    bench.write_json(checkpoint_path(), {
        "source": os.environ["GITHUB_SHA"], "frontend_threads": THREADS,
        "wrapper_sha256": wrapper_digest(), "files": files,
    })


def warm():
    compatible = restore_timestamps()
    for name, case in CASES.items():
        source = ROOT / case["path"]
        original = source.read_bytes()
        if original.decode().count(case["anchor"]) != 1:
            raise RuntimeError(f"Mutation anchor changed: {name}")
        (RECORD / f"original-{name}.rs").write_bytes(original)
        if not compatible:
            # RUSTC_WRAPPER deliberately avoids changing dependency artifact
            # hashes. Force the selected crates once when instrumentation or
            # frontend settings are new; subsequent samples reuse that state.
            os.utime(source, None)
    bench.write_json(RECORD / "provenance.json", {
        "source": os.environ["GITHUB_SHA"], "profile": "dev", "frontend_threads": THREADS,
        "rustflags": os.environ["RUSTFLAGS"], "target": os.environ["CARGO_BUILD_TARGET"],
        "cache_key": os.environ.get("OMP_DEVELOPMENT_CACHE_KEY"),
        "restored_cache_key": os.environ.get("OMP_DEVELOPMENT_RESTORED_CACHE_KEY"),
        "samples_per_case": 3, "cases": {n: c["path"] for n, c in CASES.items()},
        "instrumentation": "time-passes on pi_natives/pi_builtins/pi_shell; all threads use the same instrumented wrapper",
        "scope": "incremental edits in one checkout; excludes job/cache transfer; pass timings can overlap",
    })
    build("checkpoint-build")
    for name in CASES:
        probe(f"checkpoint-{name}-probe", name)
    # NAPI_FORCE_BUILD can change after the initial typedef cache is created.
    # Stabilize it, then explicitly measure a third, unchanged invocation.
    build("settle-build")
    build("unchanged-build")
    bench.smoke("checkpoint-smoke")
    save_checkpoint()


def samples():
    results = []
    for name, case in CASES.items():
        source = ROOT / case["path"]
        original = (RECORD / f"original-{name}.rs").read_bytes()
        if source.read_bytes() != original:
            raise RuntimeError(f"Unexpected source change before {name}")
        current = original
        try:
            for index in range(1, 4):
                started = time.perf_counter()
                current = original.decode().replace(case["anchor"], case["changed"](index)).encode()
                source.write_bytes(current)
                compiled = build(f"{name}-{index}-build")
                observed = probe(f"{name}-{index}-probe", name, index)
                checked = bench.smoke(f"{name}-{index}-smoke")
                result = {
                    "case": name, "index": index, "frontend_threads": THREADS,
                    "build_install_seconds": compiled["seconds"], "cargo_seconds": compiled["cargo_seconds"],
                    "cargo_units": compiled["cargo_units"], "changed_units": [u["name"] for u in compiled["units"]],
                    "probe_seconds": observed["seconds"], "source_smoke_seconds": checked["seconds"],
                    "edit_to_verified_seconds": round(time.perf_counter() - started, 3),
                    "rustc": [{k: v for k, v in row.items() if k != "command"} for row in compiled["rustc"]],
                }
                results.append(result)
                bench.write_json(RECORD / "samples.json", results)
                print("MATRIX_RESULT " + json.dumps({k: v for k, v in result.items() if k != "rustc"}), flush=True)
        finally:
            if source.read_bytes() != current:
                raise RuntimeError(f"Concurrent edit to {name}; refusing to overwrite")
            source.write_bytes(original)
        build(f"{name}-restored-build")
        probe(f"{name}-restored-probe", name)
    bench.smoke("restored-smoke")
    bench.command("native-exports", ["bun", "scripts/slim/verify-native.ts"])
    bench.write_json(RECORD / "source-restoration.json", {
        name: (ROOT / case["path"]).read_bytes() == (RECORD / f"original-{name}.rs").read_bytes()
        for name, case in CASES.items()
    })


def summarize():
    path = RECORD / "samples.json"
    rows = json.loads(path.read_text()) if path.exists() else []
    summary = {"source": os.environ["GITHUB_SHA"], "frontend_threads": THREADS, "sample_count": len(rows), "cases": {}}
    for case in CASES:
        selected = [row for row in rows if row["case"] == case]
        if selected:
            summary["cases"][case] = {
                "samples": len(selected),
                "median_build_install_seconds": statistics.median(row["build_install_seconds"] for row in selected),
                "median_edit_to_verified_seconds": statistics.median(row["edit_to_verified_seconds"] for row in selected),
            }
    for label in ["checkpoint-build", "settle-build", "unchanged-build", "source-restoration"]:
        path = RECORD / f"{label}.json"
        if path.exists():
            summary[label] = {k: v for k, v in json.loads(path.read_text()).items() if k not in {"units", "rustc"}}
    bench.write_json(RECORD / "summary.json", summary)
    text = "```json\n" + json.dumps(summary, indent=2) + "\n```\n"
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(text)


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "NexusKMT/omp-slim":
        raise SystemExit("Compiler matrix builds run only in public OMP Slim Actions")
    if THREADS not in (1, 2, 4) or os.environ.get("OMP_NATIVE_CARGO_PROFILE") != "dev":
        raise SystemExit("Use dev profile with 1, 2 or 4 frontend threads")
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    if action not in {"warm", "samples", "summarize"}:
        raise SystemExit("Usage: benchmark-compiler.py warm|samples|summarize")
    RECORD.mkdir(parents=True, exist_ok=True)
    os.environ["RUSTC_WRAPPER"] = str(ROOT / "scripts/slim/rustc-diagnostics.py")
    os.environ["CARGO_LOG"] = "cargo::compiler::fingerprint=info,cargo::core::compiler::fingerprint=info"
    {"warm": warm, "samples": samples, "summarize": summarize}[action]()
