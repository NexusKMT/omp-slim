# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool that uses Claude—questions about its behavior refer to the code in `packages/coding-agent/`, not your current session.

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional

## Bun Over Node

This project uses Bun. Use Bun APIs where they provide a cleaner alternative; use `node:fs` for operations Bun doesn't cover.

**NEVER spawn shell commands for operations that have proper APIs** (e.g., `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync` instead).

### Where Bun Wins

| Operation | Use | Not |
|-----------|-----|-----|
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| File exists | `await Bun.file(path).exists()` | `existsSync` |
| Spawn process | `Bun.spawn()`, `Bun.spawnSync()` | `child_process` |
| Binary lookup | `Bun.which("git")` | `spawnSync(["which", "git"])` |
| HTTP server | `Bun.serve()` | `http.createServer()` |
| SQLite | `bun:sqlite` | `better-sqlite3` |
| Hashing | `Bun.hash()`, Web Crypto | `node:crypto` |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` dance |

### Where node:fs Is Correct

Bun has no native API for directory operations. Use `node:fs`:

```typescript
import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
mkdirSync(dir, { recursive: true });
```

### CLI and Scripts

Use `bun`/`bunx` instead of `node`/`npm`/`npx`. Bun auto-loads `.env` files (no dotenv needed).

### Patterns

**Subprocess streams** — cast when using pipe mode:
```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

**Password hashing** — built-in bcrypt/argon2:
```typescript
const hash = await Bun.password.hash("password", "bcrypt");
const valid = await Bun.password.verify("password", hash);
```


## Logging

**NEVER use `console.log`, `console.error`, or `console.warn`** in the coding-agent package. Console output corrupts the TUI rendering.

Use the centralized logger instead:

```typescript
import { logger } from "../core/logger";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation.

## Commands

- After code changes: `bun run check` (runs biome + tsc, get full output, no tail)
- For auto-fixable lint issues: `bun run fix` (includes unsafe fixes)
- NEVER run: `bun run dev`, `bun test` unless user instructs
- Only run specific tests if user instructs: `bun test test/specific.test.ts`
- NEVER commit unless user asks
- Do NOT use `tsc` or `npx tsc` - always use `bun run check`

## GitHub Issues

When reading issues:

- Always read all comments on the issue

When creating issues:

- Use standard GitHub labels (bug, enhancement, documentation, etc.)
- If an issue affects a specific package, mention it in the issue title or description

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## Tools

- GitHub CLI for issues/PRs
- TUI interaction: use tmux

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features
- `### Breaking Changes` - API changes requiring migration (appears first if present)

### Rules

- New entries ALWAYS go under `## [Unreleased]` section
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`

## Releasing

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   bun run release
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
