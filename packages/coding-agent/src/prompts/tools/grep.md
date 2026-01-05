A powerful search tool built on ripgrep

Usage:
- ALWAYS use grep for search tasks. NEVER invoke `grep` or `rg` as a bash command. The grep tool has been optimized for correct permissions and access.
- Searches recursively by default - no need for -r flag
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.ts", "**/*.spec.ts") or type parameter (e.g., "ts", "py", "rust") - equivalent to grep's --include
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Pagination: Use headLimit to limit results (like `| head -N`), offset to skip first N results
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`
