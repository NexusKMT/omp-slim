#!/usr/bin/env bash
set -euo pipefail

omp_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$omp_repo_root"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
omp_bun_version=1.4.4
omp_rust_toolchain="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)"
test -n "$omp_rust_toolchain"

if [[ "$(uname -s)" != Linux ]]; then
  printf 'This bootstrap targets the Linux Codespace. Use the upstream host setup elsewhere.\n' >&2
  exit 2
fi

omp_build_packages=(build-essential clang lld libclang-dev cmake ninja-build pkg-config libssl-dev autoconf automake libtool nasm unzip zstd python3)
omp_missing_packages=()
for omp_package in "${omp_build_packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${Status}' "$omp_package" 2>/dev/null || true)" != 'install ok installed' ]]; then
    omp_missing_packages+=("$omp_package")
  fi
done
if (( ${#omp_missing_packages[@]} )); then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${omp_missing_packages[@]}"
fi

omp_setup_tmp="$(mktemp -d /tmp/omp-slim-setup.XXXXXX)"
trap 'rm -rf -- "$omp_setup_tmp"' EXIT
if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$omp_bun_version" ]]; then
  curl --fail --location --silent --show-error https://bun.com/install -o "$omp_setup_tmp/install-bun.sh"
  bash "$omp_setup_tmp/install-bun.sh" "bun-v$omp_bun_version"
fi
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs -o "$omp_setup_tmp/install-rust.sh"
  sh "$omp_setup_tmp/install-rust.sh" -y --profile minimal --default-toolchain none --no-modify-path
fi
rustup toolchain install "$omp_rust_toolchain" --profile minimal --component rustfmt --component clippy
bun install --frozen-lockfile
printf 'Bun: %s\nRust toolchain: %s\n' "$(bun --version)" "$omp_rust_toolchain"
df -h /workspaces /tmp
