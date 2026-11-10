#!/usr/bin/env bash
set -euo pipefail

omp_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$omp_repo_root"
[[ "$(uname -sm)" == 'Darwin x86_64' ]] || exit 2
[[ "$(bun --version)" == 1.4.4 ]] || exit 2
omp_source_sha="$(git rev-parse HEAD)"
[[ "$omp_source_sha" == "${GITHUB_SHA:-}" ]] || exit 2
omp_validation="$omp_repo_root/dist/validation/macos-tests"
[[ -s "$omp_validation/provenance.txt" && -s "$omp_validation/SHA256SUMS" ]] || exit 2
shasum -a 256 -c "$omp_validation/SHA256SUMS"
omp_build_dir="$omp_repo_root/dist/builds/reused-cli-$omp_source_sha"
mkdir -p "$omp_build_dir"
export PI_CODING_AGENT_DIR="$omp_build_dir/agent"
export PI_CONFIG_DIR="$omp_build_dir/config"
export OMP_BUILD_LABEL="omp-slim/single-model-${omp_source_sha:0:10}"
exec > >(tee -a "$omp_build_dir/build.log") 2>&1
trap 'omp_exit=$?; printf "%s\n" "$omp_exit" > "$omp_build_dir/exit-code"; exit "$omp_exit"' EXIT
printf '%s\n' "$omp_source_sha" > "$omp_build_dir/source-commit"
git status --porcelain=v1 > "$omp_build_dir/source-status"
cp "$omp_validation/provenance.txt" "$omp_build_dir/native-provenance.txt"
cp "$omp_validation/SHA256SUMS" "$omp_build_dir/native-SHA256SUMS"
bun --version > "$omp_build_dir/bun-version"
omp_started=$SECONDS
bun --cwd=packages/coding-agent run build
printf '%s\n' "$((SECONDS - omp_started))" > "$omp_build_dir/cli-build-seconds"
omp_binary="$omp_repo_root/packages/coding-agent/dist/omp"
lipo "$omp_binary" -verify_arch x86_64
codesign --verify --strict "$omp_binary"
otool -l "$omp_binary" | awk '
  $1 == "cmd" && $2 ~ /^LC_(LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB|LAZY_LOAD_DYLIB)$/ { dependency=1; next }
  dependency && $1 == "name" { print $2; dependency=0 }
' > "$omp_build_dir/macos-dependencies.txt"
if grep -Eq '^/(opt/homebrew|usr/local|Users/runner)/' "$omp_build_dir/macos-dependencies.txt"; then
  cat "$omp_build_dir/macos-dependencies.txt" >&2
  exit 1
fi
"$omp_binary" --version | tee "$omp_build_dir/version.txt"
"$omp_binary" --help > "$omp_build_dir/help.txt"
"$omp_binary" --smoke-test
git status --porcelain=v1 > "$omp_build_dir/source-status-after"
cp "$omp_binary" "$omp_build_dir/omp"
cd "$omp_build_dir"
shasum -a 256 omp > SHA256SUMS
tar -czf omp-darwin-x64.tar.gz omp SHA256SUMS source-commit source-status source-status-after \
  native-provenance.txt native-SHA256SUMS bun-version cli-build-seconds macos-dependencies.txt version.txt help.txt
shasum -a 256 omp-darwin-x64.tar.gz > ARCHIVE-SHA256SUMS
