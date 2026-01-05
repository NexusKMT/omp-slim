Structured Git operations with safety guards and typed output. Use this tool instead of raw git commands.

Operations:
- READ: status, diff, log, show, blame, branch
- WRITE: add, restore, commit, checkout, merge, rebase, stash, cherry-pick
- REMOTE: fetch, pull, push, tag
- GITHUB: pr, issue, ci, release

Returns structured data plus a rendered summary for display. Safety checks may block or require confirmation for destructive actions.
