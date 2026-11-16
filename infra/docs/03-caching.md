# 03 — Caching

vmon sandboxes share no filesystem: every job forks the same `omp-ci` snapshot and its writes die with it. CI caches therefore come from two places: the `omp-ci` template and the vmon node's Actions cache. There is no cache infrastructure of this repo's own.

| Cache | Where | Written by | Read by |
| --- | --- | --- | --- |
| bun package store | `~/.bun/install/cache` in the template; `bun-<os>-<lockhash>` Actions cache entry | template build; main's GitHub-hosted jobs (`bun-cache-warm.yml`, release jobs) | vmon jobs (template); GitHub-hosted jobs (Actions cache) |
| Cargo registry | `~/.cargo/registry` in the template | template build | `check` (`cargo fetch --locked`, then offline `cargo deny`) |

Template caches are refreshed by rebuilding `omp-ci` ([02-omp-ci-template.md](02-omp-ci-template.md#2-freshness)).

## 1. Actions cache

Workflows use the GitHub Actions cache unchanged (`actions/cache`, `Swatinem/rust-cache`, the `cache:` options of `setup-*`). On a vmon runner the `ci` template's runner sends those requests to the node the sandbox runs on, which stores the archives on vmon nodes instead of at GitHub; artifact uploads and downloads still go to GitHub. Scopes follow GitHub's rules (a job saves to its own ref and restores from its own ref, then the base branch, then the default branch). GitHub-hosted jobs keep using GitHub's cache, so entries saved on vmon runners and on GitHub-hosted runners are separate stores with the same keys.

Inspect or drop entries with `vmon admin ci caches --repo <OWNER>/<REPO>` and `vmon admin ci caches delete <OWNER>/<REPO> --key-prefix <prefix>`, or on the vmon dashboard's CI page.

## 2. Poisoning boundary

The node cache accepts writes only from jobs saving to a branch or tag, i.e. trusted pushes, dispatches and releases; pull request jobs save entries only to their own `refs/pull/<n>/merge` scope, and vmon refuses jobs from actors outside the public-repo allow-list ([01-vmon-runners.md](01-vmon-runners.md#4-trust-split)). Nothing else is shared between jobs: `node_modules` and Cargo `target/` live and die inside each sandbox, and the template caches are written only at template build time.

## 3. Operate

- **Hit rates.** Actions cache restores and saves appear in each job's log with their key and size; a warm build restores the bun store and fetches no packages.
- **Cold node.** A node that never served this repository fetches misses from the other nodes; a fully cold cluster rebuilds once and repopulates.
- **Reset a cache.** Use `vmon admin ci caches delete` for Actions cache entries; template caches are refreshed by rebuilding `omp-ci`.
