#!/usr/bin/env python3
"""Record rustc stages for selected crates without changing dependency flags."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def argument_value(arguments, option):
    if option in arguments:
        return arguments[arguments.index(option) + 1]
    return next((a.split("=", 1)[1] for a in arguments if a.startswith(option + "=")), None)


def main():
    compiler, *arguments = sys.argv[1:]
    crate = argument_value(arguments, "--crate-name")
    selected = set(os.environ.get("OMP_DIAGNOSTIC_CRATES", "pi_natives,pi_shell,pi_builtins").split(","))
    if crate not in selected:
        os.execv(compiler, [compiler, *arguments])

    threads = int(os.environ.get("OMP_FRONTEND_THREADS", "1"))
    if threads not in (1, 2, 4):
        raise SystemExit("OMP_FRONTEND_THREADS must be 1, 2 or 4")
    record = Path(os.environ["OMP_DIAGNOSTIC_DIR"])
    record.mkdir(parents=True, exist_ok=True)
    stem = f"{crate}-{time.time_ns()}-{os.getpid()}"
    extra = ["-Ztime-passes", "-Ztime-passes-format=json", "-Zunstable-options", f"--jobs-frontend={threads}"]
    started = time.perf_counter()
    phases = []
    # Cargo's jobserver descriptors must reach rustc so LLVM shares the same
    # CPU budget. Python otherwise closes them when spawning a child.
    descriptors = set()
    for pair in re.findall(r"--jobserver-(?:fds|auth)=(\d+),(\d+)", os.environ.get("CARGO_MAKEFLAGS", "")):
        descriptors.update(int(fd) for fd in pair)
    with (record / f"{stem}.stderr.log").open("w") as log:
        process = subprocess.Popen([compiler, *arguments, *extra], stderr=subprocess.PIPE, text=True, pass_fds=tuple(descriptors))
        for line in process.stderr:
            log.write(line)
            if line.startswith("time: {"):
                phases.append(json.loads(line[len("time: "):]))
            else:
                sys.stderr.write(line)
                sys.stderr.flush()
        status = process.wait()
    result = {
        "crate": crate, "command": [compiler, *arguments, *extra],
        "frontend_threads": threads, "seconds": round(time.perf_counter() - started, 3),
        "exit_code": status, "phases": phases,
        "note": "rustc phase intervals can nest or overlap; do not sum them as wall time",
    }
    (record / f"{stem}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"OMP_RUSTC_RESULT crate={crate} seconds={result['seconds']} frontend_threads={threads} exit={status}", file=sys.stderr)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
