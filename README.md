# OMP Slim

[简体中文](README.zh-CN.md) · [Build and validation procedures](SLIM.md)

OMP Slim is an independent downstream of [OMP](https://github.com/can1357/oh-my-pi),
based on v18.18.3. It is a terminal coding agent for **macOS Intel and Linux x64**,
using one selected model through an explicitly configured Chat Completions endpoint.

The retained core includes session history and resume, file editing and search,
shell and PTY execution, LSP and debugger tools, subagents, context compaction,
HTTP web search, MCP, manually managed skills, and the local stats dashboard.
Planning, subagents, and helper requests inherit the main model.

Built-in browser automation, desktop control, speech, automatic long-term memory,
provider subscriptions and alternate transports, automatic model switching,
sharing and recording, SSH host management, Apple Foundation Models, external RPC SDKs,
and upstream self-update are removed. The benchmark-only metaharness and Snapcompact
research tree are removed; the Snapcompact runtime remains.

## Install and update

Use source and artifacts from **[NexusKMT/omp-slim](https://github.com/NexusKMT/omp-slim)**.
The upstream npm package, installer, Homebrew tap, and mise package distribute OMP.
They are not distribution channels for this fork.

For a prebuilt Intel Mac binary, download an artifact from a successful
[downstream build](https://github.com/NexusKMT/omp-slim/actions/workflows/slim-macos-intel.yml).
Check the source revision and validation logs, verify `ARCHIVE-SHA256SUMS`, extract
the archive, then verify its `SHA256SUMS` with `shasum -a 256 -c SHA256SUMS`.
Run the extracted `omp --version` before installing the binary into your PATH.
The workflow uses ad-hoc signing; artifacts and their validation history are
explained in [SLIM.md](SLIM.md).

To build from source on a supported host with Bun and the pinned Rust toolchain:

```sh
git clone https://github.com/NexusKMT/omp-slim.git
cd omp-slim
bun install --frozen-lockfile
bash scripts/slim/build.sh slim
```

Build archives, checksums, source provenance, and logs are written under
`dist/builds/`. For project development, full native and standalone builds run
in the remote workflows documented in [SLIM.md](SLIM.md).

Update by installing a newly verified downstream artifact or rebuilding the
selected source revision. `omp update`, its background worker, and startup
version checks are removed. Plugin marketplace updates remain separate.

## Configure a model

Declare your endpoint and model IDs in `~/.omp/agent/models.yml`; see
[model configuration](docs/models.md). Select the main model with:

```sh
omp --model my-endpoint/my-model
```

`/model` changes it interactively. All model requests use `openai-completions`;
unsupported transport names are rejected. See [single-model behavior](docs/slim-single-model.md).

## Develop and validate

```sh
bun run check:ts           # lint, formatting, root scripts, and package types
bun run test:scripts       # build/release helper contracts
```

Run focused tests for the area being changed. Full native builds, Rust tests,
standalone worker smoke tests, and the complete TypeScript suite use the manual
public Actions workflows.

| Component | Location |
| --- | --- |
| CLI, sessions, tools, and MCP | [coding-agent](packages/coding-agent) |
| Chat Completions transport | [ai](packages/ai) |
| Explicit model metadata and pricing | [catalog](packages/catalog) |
| Agent runtime | [agent](packages/agent) |
| Terminal UI | [tui](packages/tui) |
| Native bindings, shell, and file operations | [natives](packages/natives), [Rust crates](crates) |
| Local usage dashboard | [stats](packages/stats) |
| Context image rendering | [snapcompact](packages/snapcompact) |
| RPC clients | [sdk](sdk) |

## License and origin

MIT; see [LICENSE](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.txt).
OMP was built by Stencil Labs and derives from [Pi](https://github.com/badlogic/pi-mono)
by Mario Zechner. Original attribution and historical changelogs remain in this
repository. Historical removal and validation reports are linked from [SLIM.md](SLIM.md).
