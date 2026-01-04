# Release Command

Release all packages with the specified version.

## Arguments

- `$ARGUMENTS`: The version number (semver, e.g., `3.13.0`)

## Usage

Run the release script:

```bash
bun scripts/release.ts $ARGUMENTS
```

The script handles everything automatically:
1. Pre-flight checks (clean working dir, on main branch)
2. Updates all package.json versions
3. Regenerates bun.lock
4. Updates CHANGELOGs ([Unreleased] → [version] - date)
5. Commits and tags
6. Pushes to origin
7. Watches CI until all workflows pass

## Handling CI Failures

If CI fails, the script exits with an error. Fix the issue, then:

```bash
git commit --amend --no-edit
git push origin main --force
git tag -f v$ARGUMENTS && git push origin v$ARGUMENTS --force
bun scripts/release.ts watch
```

The `watch` subcommand re-watches CI for the current commit until all checks pass.
