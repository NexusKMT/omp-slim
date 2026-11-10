#!/usr/bin/env bash
set -euo pipefail

omp_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$omp_repo_root"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
omp_platform="$(bun -p process.platform)"
omp_arch="$(bun -p process.arch)"
case "$omp_platform-$omp_arch" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
  *) printf 'Unsupported build host: %s-%s\n' "$omp_platform" "$omp_arch" >&2; exit 2 ;;
esac
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
# stay inside the checkout for artifact recovery.
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
{
  uname -a
  printf 'Target: %s-%s\n' "$omp_platform" "$omp_arch"
  if [[ "$omp_platform" == darwin ]]; then
    sw_vers
    xcodebuild -version
    xcrun --show-sdk-version
    printf 'MACOSX_DEPLOYMENT_TARGET: %s\n' "${MACOSX_DEPLOYMENT_TARGET:-default}"
  fi
} > "$omp_build_dir/build-host.txt"
df -h "$omp_repo_root" "${TMPDIR:-/tmp}"
omp_native_started=$SECONDS
bun run build:native
printf '%s\n' "$((SECONDS - omp_native_started))" > "$omp_build_dir/native-build-seconds"
omp_cli_started=$SECONDS
bun --cwd=packages/coding-agent run build
printf '%s\n' "$((SECONDS - omp_cli_started))" > "$omp_build_dir/cli-build-seconds"
omp_binary="$omp_repo_root/packages/coding-agent/dist/omp"
if [[ "$omp_platform" == darwin ]]; then
  omp_macho_arch="$omp_arch"
  [[ "$omp_arch" != x64 ]] || omp_macho_arch=x86_64
  lipo "$omp_binary" -verify_arch "$omp_macho_arch"
  codesign --verify --strict "$omp_binary"
  {
    file "$omp_binary"
    otool -L "$omp_binary"
    xcrun vtool -show-build "$omp_binary"
    for omp_addon in packages/natives/native/pi_natives."$omp_platform-$omp_arch"*.node; do
      lipo "$omp_addon" -verify_arch "$omp_macho_arch"
      file "$omp_addon"
      otool -L "$omp_addon"
      xcrun vtool -show-build "$omp_addon"
    done
  } > "$omp_build_dir/macos-linkage.txt"
  if grep -Eq '^[[:space:]]+/(opt/homebrew|usr/local|Users/runner)/' "$omp_build_dir/macos-linkage.txt"; then
    printf 'Artifact contains a dependency on a build-machine path.\n' >&2
    exit 1
  fi
fi
"$omp_binary" --version | tee "$omp_build_dir/version.txt"
"$omp_binary" --help > "$omp_build_dir/help.txt"
"$omp_binary" --smoke-test
git status --porcelain=v1 > "$omp_build_dir/source-status-after"
cp "$omp_binary" "$omp_build_dir/omp"
(
  cd "$omp_build_dir"
  omp_sha256=(shasum -a 256)
  if command -v sha256sum >/dev/null; then omp_sha256=(sha256sum); fi
  "${omp_sha256[@]}" omp > SHA256SUMS
  omp_archive="omp-$omp_platform-$omp_arch.tar.gz"
  omp_metadata=(SHA256SUMS source-commit source-status source-status-after bun-version rust-version native-build-seconds cli-build-seconds help.txt build-host.txt version.txt)
  if [[ "$omp_platform" == darwin ]]; then omp_metadata+=(macos-linkage.txt); fi
  tar -czf "$omp_archive" omp "${omp_metadata[@]}"
  "${omp_sha256[@]}" "$omp_archive" > ARCHIVE-SHA256SUMS
)
printf 'Build artifacts: %s\n' "$omp_build_dir"
