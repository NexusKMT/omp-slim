Sparse edit format: name a few distinctive fragments, elide the rest with `…`, type only what changes.

<ops>
Payload = a `[relative/path.ts]` header naming the file, then one or more operations; EOF ends the payload. Repeat a `[path]` header to edit another file in the same call — sections apply atomically, so any failure leaves every file untouched.

Operation = line `«`, MATCH lines, line `»`, REWRITE lines. MATCH describes the file as it reads now; REWRITE is the text you want in its place.

Openers: `«` targets one unique match. `«*` applies the same REWRITE at every match.

Inside MATCH:
- `…` — a gap standing for text you chose not to type. Between two fragments on one line it stays on that line; at a line end or alone on a line it spans lines.
- `⟪OLD⟫` — change only OLD; the rest of MATCH is context that survives untyped. `⟪⟫` inserts at that point.
- no markers — MATCH is the current text verbatim and the whole match is replaced.

Inside REWRITE:
- Empty REWRITE deletes the match.
- `…` re-emits the kth gap you selected, in order.
- A line `»N` re-emits the code operation N deleted, so a move never retypes the block.
</ops>

<rules>
- Your MATCH MUST include a fragment of the line you are changing; surrounding context alone can match the wrong place.
- Adding new code? Match an existing neighbour line and repeat that line in REWRITE alongside the addition.
- One match only. Same rewrite everywhere → `«*`. Otherwise add context only the intended match has — the error hands you a ready payload. The tool NEVER guesses between candidates.
- Several `⟪OLD⟫` in one MATCH: give REWRITE that many segments — one per line, or multi-line groups separated by a lone `…` — applied in order.
- Every operation addresses the file as it was before this call; earlier operations never shift later anchors.
- Matching ignores whitespace and indentation and forgives identifier typos; operators and delimiters MUST match exactly.
- REWRITE indentation is written through as authored, so indentation-only edits work.
- A failure applies nothing. The error shows the current lines and a corrected operation: send that. NEVER re-read first, and NEVER resend a payload unchanged.
- "No change" means your anchor found text that already reads the way you want — the bug is elsewhere; look farther.
- To write `«`, `»`, `⟪`, or `⟫` into a file, use `write`.
</rules>

<example>
Change one thing, keeping its line as context:
```text
[src/config.ts]
«
const timeout = ⟪1000⟫;
»
5000
```

Unsure how sparse to be? Quoting the current text verbatim always works:
```text
[src/config.ts]
«
const timeout = 1000;
»
const timeout = 5000;
```

Fix the same typo at every site:
```text
[src/catalog.ts]
«*
= ⟪avlue⟫;
»
value
```

Two files, one call:
```text
[src/api.ts]
«
export const VERSION = ⟪'1.2.0'⟫;
»
'1.3.0'
[src/cli.ts]
«
banner(⟪'v1.2.0'⟫)
»
'v1.3.0'
```

Move a block: delete it, then re-emit it at the destination with `»1`:
```text
[src/util.ts]
«
const helper = () => {
  return 1;
};
»
«
const target = () => 2;
»
»1
```

Rewrite inside a block, letting gaps carry the untyped lines through:
```text
[src/users.ts]
«
loadUser(…
⟪const cached = …
const user = legacyStore.read(…);
return user;⟫
…}
»
const cached = …
const user = await database.users.read(…);
return user;
```
</example>

<anti-patterns>
WRONG — anchoring around the change instead of on it; this can land on the wrong call site:
```text
[src/service.ts]
«
resolveSecondary(⟪…⟫auditSecondary(
»
return nextValue;
```
RIGHT — name the line being changed:
```text
[src/service.ts]
«
resolveSecondary(…
⟪return value;⟫…
auditSecondary(
»
return nextValue;
```

WRONG — matching the line you want to create; it is not in the file yet:
```text
[src/index.ts]
«
case 'end_turn':
»
case 'end_turn':
```
RIGHT — match the neighbour it goes next to, and include both:
```text
[src/index.ts]
«
⟪⟫case 'pause_turn':
»
case 'end_turn':
```

WRONG — moving a block by overwriting it with the destination line, which loses the block:
```text
[src/util.ts]
«
const helper = () => {
  return 1;
};
»
const target = () => 2;
```
RIGHT — delete, then `»1` at the destination (see the move example above).
</anti-patterns>

<critical>
1. First line is the `[path]` header.
2. MATCH is the current text; REWRITE is the final text.
3. Prove the target: one unique match, anchored on the line you are changing.
4. Prefer sparse `…`; quoting verbatim is always valid when unsure.
5. After an error, send the corrected operation it gives you — nothing was applied.
</critical>
