#!/usr/bin/env bash
set -euo pipefail

omp_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$omp_repo_root"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
omp_label="${1:-baseline}"
if [[ ! "$omp_label" =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf 'Build label must contain only letters, digits, underscores or hyphens.\n' >&2
  exit 2
fi
omp_build_id="${omp_label}-$(date -u +%Y%m%dT%H%M%SZ)"
omp_build_dir="$omp_repo_root/dist/builds/$omp_build_id"
mkdir -p "$omp_build_dir"
printf '%s\n' "$omp_build_id" > "$omp_repo_root/dist/builds/latest"
exec > >(tee -a "$omp_build_dir/build.log") 2>&1
trap 'omp_exit=$?; printf "%s\n" "$omp_exit" > "$omp_build_dir/exit-code"; exit "$omp_exit"' EXIT

# Only compiler intermediates live on the temporary disk. Logs and deliverables
# are in /workspaces and can be recovered before stopping/deleting the instance.
export CARGO_TARGET_DIR="${OMP_SLIM_CARGO_TARGET_DIR:-/tmp/omp-slim-cargo-$UID}"
export CARGO_BUILD_JOBS="${OMP_SLIM_BUILD_JOBS:-2}"
export OMP_NATIVE_BUILD_BACKEND=cargo
export OMP_NATIVE_CARGO_PROFILE=ci
export PI_CODING_AGENT_DIR="$omp_build_dir/agent"
export OMP_BUILD_LABEL="omp-slim/$omp_build_id"
export OMP_SLIM_BUILD_DIR="$omp_build_dir"

git rev-parse HEAD > "$omp_build_dir/source-commit"
git status --porcelain=v1 > "$omp_build_dir/source-status"
bun --version > "$omp_build_dir/bun-version"
rustc --version > "$omp_build_dir/rust-version"
df -h /workspaces /tmp
omp_native_started=$SECONDS
bun run build:native
printf '%s\n' "$((SECONDS - omp_native_started))" > "$omp_build_dir/native-build-seconds"
omp_cli_started=$SECONDS
bun --cwd=packages/coding-agent run build
printf '%s\n' "$((SECONDS - omp_cli_started))" > "$omp_build_dir/cli-build-seconds"
omp_binary="$omp_repo_root/packages/coding-agent/dist/omp"
"$omp_binary" --version
"$omp_binary" --help > "$omp_build_dir/help.txt"
"$omp_binary" --smoke-test
git status --porcelain=v1 > "$omp_build_dir/source-status-after"
cp "$omp_binary" "$omp_build_dir/omp"
(
  cd "$omp_build_dir"
  sha256sum omp > SHA256SUMS
  tar -czf omp-linux-x64.tar.gz omp SHA256SUMS source-commit source-status source-status-after bun-version rust-version native-build-seconds cli-build-seconds help.txt
  sha256sum omp-linux-x64.tar.gz > ARCHIVE-SHA256SUMS
)
printf 'Build artifacts: %s\n' "$omp_build_dir"
