#!/usr/bin/env bash
set -euo pipefail

omp_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$omp_repo_root"
omp_report=dist/validation/macos-tests
mkdir -p "$omp_report"
fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ "${OMP_NATIVE_BUILD_RUN_ID:-}" =~ ^[0-9]+$ ]] || fail 'build_run_id must contain only digits.'
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Missing repository identity.'
[[ "$(uname -sm)" == 'Darwin x86_64' ]] || fail 'Native reuse requires an Intel Mac.'
[[ "$(bun --version)" == 1.4.4 ]] || fail 'Native validation requires Bun 1.4.4.'
omp_target_sha="$(git rev-parse HEAD)"
[[ "$omp_target_sha" == "${GITHUB_SHA:-}" ]] || fail 'Checkout does not match the requested source.'
omp_api="repos/$GITHUB_REPOSITORY/actions"
gh api "$omp_api/runs/$OMP_NATIVE_BUILD_RUN_ID" > "$omp_report/build-run.json"
jq -e --arg repo "$GITHUB_REPOSITORY" --arg id "$OMP_NATIVE_BUILD_RUN_ID" '
  (.id | tostring) == $id and .repository.full_name == $repo and
  .head_repository.full_name == $repo and .repository.private == false and
  .path == ".github/workflows/slim-macos-intel.yml" and .event == "workflow_dispatch" and
  .status == "completed" and (.conclusion == "success" or .conclusion == "failure") and
  (.head_sha | test("^[0-9a-f]{40}$")) and (.run_attempt >= 1)
' "$omp_report/build-run.json" > /dev/null || fail 'Source must be a completed build from this public repository.'
omp_source_sha="$(jq -r .head_sha "$omp_report/build-run.json")"
omp_attempt="$(jq -r .run_attempt "$omp_report/build-run.json")"
gh api --paginate --slurp "$omp_api/runs/$OMP_NATIVE_BUILD_RUN_ID/attempts/$omp_attempt/jobs?per_page=100" > "$omp_report/build-jobs.json"
jq -e '
  any(.[].jobs[]; .name == "macOS 15 Intel build and smoke test" and
    (.labels | index("macos-15-intel") != null) and
    any(.steps[]; .name == "Compile and verify native addon and standalone CLI" and .conclusion == "success"))
' "$omp_report/build-jobs.json" > /dev/null || fail 'The source run did not successfully build and verify its native addon.'

git fetch --no-tags --depth=1 origin "$omp_source_sha"
git diff --no-renames --name-only "$omp_source_sha" "$omp_target_sha" > "$omp_report/source-diff.txt"
git diff --no-renames --name-only -z "$omp_source_sha" "$omp_target_sha" > "$omp_report/source-diff.nul"
# Include crate resources and vendored C/Swift as well as Rust, and the complete
# Cargo/N-API build chain. Test-only edits can reuse an addon; any build input
# change needs a new build. Do not include this reuse script or its workflow.
: > "$omp_report/changed-native-inputs.txt"
while IFS= read -r -d '' omp_path; do
  case "$omp_path" in
    # Generated standalone RPC SDK Rust is not linked into the native addon.
    sdk/rust/*) continue ;;
    *.rs|Cargo.toml|Cargo.lock|*/Cargo.toml|*/Cargo.lock|rust-toolchain*|*/rust-toolchain*|.cargo/*|*/.cargo/*|crates/*) ;;
    packages/natives/test/*|packages/natives/bench/*|packages/natives/README.md|packages/natives/CHANGELOG.md|packages/natives/THIRD-PARTY-NOTICES.txt) continue ;;
    packages/natives/*|package.json|bun.lock|bunfig.toml|.npmrc|patches/*) ;;
    scripts/bazel-natives.ts|scripts/host-detect.ts|scripts/stamp-native-version.ts) ;;
    scripts/slim/bootstrap.sh|scripts/slim/build.sh|scripts/slim/verify-native.ts|.github/workflows/slim-macos-intel.yml) ;;
    *) continue ;;
  esac
  printf '%s\n' "$omp_path" >> "$omp_report/changed-native-inputs.txt"
done < "$omp_report/source-diff.nul"
if [[ -s "$omp_report/changed-native-inputs.txt" ]]; then
  cat "$omp_report/changed-native-inputs.txt" >&2
  fail 'Native build inputs differ; run the full Intel Mac build workflow first.'
fi
{
  printf 'Validation source: %s\nNative source: %s\n' "$omp_target_sha" "$omp_source_sha"
  printf 'Native build: https://github.com/%s/actions/runs/%s (attempt %s)\n' "$GITHUB_REPOSITORY" "$OMP_NATIVE_BUILD_RUN_ID" "$omp_attempt"
  printf 'Native build inputs: identical\nBun: %s\n' "$(bun --version)"
  uname -a
  sw_vers
} > "$omp_report/provenance.txt"

gh api --paginate --slurp "$omp_api/runs/$OMP_NATIVE_BUILD_RUN_ID/artifacts?per_page=100" > "$omp_report/build-artifacts.json"
omp_download_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/omp-slim-native-reuse.XXXXXX")"
trap 'rm -rf -- "$omp_download_dir"' EXIT
: > "$omp_report/ARCHIVE-SHA256SUMS"
for omp_kind in addon bindings; do
  omp_name="omp-slim-native-$omp_kind-$omp_source_sha"
  jq -e --arg name "$omp_name" --arg sha "$omp_source_sha" --arg run "$OMP_NATIVE_BUILD_RUN_ID" '
    [.[].artifacts[] | select(.name == $name and .expired == false and
      (.workflow_run.id | tostring) == $run and .workflow_run.head_sha == $sha)] |
    if length == 1 then .[0] else error("Expected exactly one matching, unexpired source artifact") end
  ' "$omp_report/build-artifacts.json" > "$omp_report/$omp_kind-artifact.json"
  omp_artifact_id="$(jq -er '.id | numbers' "$omp_report/$omp_kind-artifact.json")"
  omp_digest="$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' "$omp_report/$omp_kind-artifact.json")"
  omp_zip="$omp_download_dir/$omp_kind.zip"
  gh api "$omp_api/artifacts/$omp_artifact_id/zip" > "$omp_zip"
  omp_actual="$(shasum -a 256 "$omp_zip" | cut -d ' ' -f 1)"
  [[ "$omp_digest" == "sha256:$omp_actual" ]] || fail "Artifact checksum mismatch: $omp_name"
  printf '%s  %s.zip\n' "$omp_actual" "$omp_name" >> "$omp_report/ARCHIVE-SHA256SUMS"
  unzip -Z -1 "$omp_zip" | LC_ALL=C sort > "$omp_report/$omp_kind-files.txt"
done

# Extract only these named files, after verifying the complete archive inventory.
printf '%s\n' pi_natives.darwin-x64-modern.node > "$omp_download_dir/addon-files.txt"
printf '%s\n' index.d.ts index.js > "$omp_download_dir/bindings-files.txt"
cmp "$omp_download_dir/addon-files.txt" "$omp_report/addon-files.txt"
cmp "$omp_download_dir/bindings-files.txt" "$omp_report/bindings-files.txt"
for omp_binding in index.js index.d.ts; do
  unzip -p "$omp_download_dir/bindings.zip" "$omp_binding" > "$omp_report/$omp_binding"
  cmp "$omp_report/$omp_binding" "packages/natives/native/$omp_binding"
done
omp_addon=packages/natives/native/pi_natives.darwin-x64-modern.node
unzip -p "$omp_download_dir/addon.zip" "$(basename "$omp_addon")" > "$omp_addon"
shasum -a 256 "$omp_addon" packages/natives/native/index.js packages/natives/native/index.d.ts > "$omp_report/SHA256SUMS"
lipo "$omp_addon" -verify_arch x86_64
bun scripts/slim/verify-native.ts
bun -e '
  import { __piNativesBuildVersion } from "./packages/natives/native/index.js";
  const { version } = await Bun.file("packages/natives/package.json").json();
  if (__piNativesBuildVersion() !== version) throw new Error("Native addon version mismatch");
  console.log(`Native package version verified: ${version}`);
'
printf 'Native artifact checksums, generated bindings, architecture, version and exports verified.\n' >> "$omp_report/provenance.txt"
