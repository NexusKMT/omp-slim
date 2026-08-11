<critical>
- You NEVER edit project files; this is a read-and-verify discovery task.
- You MUST verify every command you propose by running it once.
- Your final message MUST be exactly one JSON object matching the schema below — no prose, no code fences.
</critical>

# Checker Discovery

The user asked `omp cleanse` to detect and repair: **{{request}}**

Determine which project command(s) surface exactly those diagnostics so the orchestrator can run them, parse their output, and dispatch repair agents.

<workflow>
1. Inspect the project (manifests, configs, lockfiles, scripts) to identify the relevant tooling.
2. Determine the exact command and working directory. Prefer project-local binaries (`node_modules/.bin`, `.venv/bin`, wrappers like `gradlew`) over global tools.
3. Prefer a machine-readable output flag matching a known parser below. Otherwise pick a format that prints gcc-style `file:line:col: severity: message` lines and use parser `generic`.
4. Run the command once to verify it executes and its output matches the chosen parser. A non-zero exit with parseable diagnostics is fine; a crash or usage error is not.
5. If several commands are needed to cover the request, return one entry per command.
</workflow>

## Known parsers

| id | expected output |
|---|---|
| `rust` | `cargo … --message-format=json` |
| `rust-test` | `cargo test … --message-format=json` |
| `go` | `go vet -json` |
| `go-test` | `go test -json` |
| `staticcheck` | `staticcheck -f json` |
| `golangci` | golangci-lint default text output |
| `ruff` | `ruff check --output-format=json` |
| `pyright` | `pyright`/`basedpyright` `--outputjson` |
| `mypy` | mypy default text output |
| `pylint` | `pylint --output-format=json` |
| `flake8` | flake8 default text output |
| `ty` | `ty check --output-format concise` |
| `eslint` | `eslint --format=json` |
| `biome` | `biome check --reporter=json` |
| `oxlint` | unix-format lines `file:line:col: message [Error/rule]` (`--format=unix`) |
| `deno-lint` | `deno lint --json` |
| `stylelint` | `stylelint --formatter json` |
| `rubocop` | `rubocop --format json` |
| `phpstan` | `phpstan analyse --error-format=json` |
| `psalm` | `psalm --output-format=json` |
| `swiftlint` | `swiftlint lint --reporter json` |
| `dart` | `dart analyze --format machine` |
| `credo` | `mix credo --format=json` |
| `shellcheck` | `shellcheck --format=json1` |
| `hlint` | `hlint --json` |
| `terraform` | `terraform validate -json` |
| `tflint` | `tflint --format=json` |
| `actionlint` | actionlint with its JSON `-format` template |
| `generic` | gcc-style `file:line:col: severity: message` lines (tsc/tsgo `--pretty false`, mypy, clang, zig, MSVC-style) |

## Output schema

```json
{
	"checkers": [
		{
			"label": "tsc (packages/app)",
			"language": "TypeScript",
			"cwd": "packages/app",
			"command": ["tsc", "--noEmit", "--pretty", "false"],
			"parser": "generic"
		}
	]
}
```

- `command`: argv array; the first element is a binary name or project-relative path. Never wrap in a shell.
- `cwd`: project-relative working directory; omit for the project root.
- `parser`: one of the known parser ids; omit for `generic`.
- Return `"checkers": []` only when nothing in this project can produce the requested diagnostics.
