Submit a compressed draft of the source text, together with everything the draft drops.

- `text` — the complete compressed output, verbatim and ready to ship. NEVER a diff, a summary, or a description of your changes.
- `losses` — one entry per claim, qualifier, default, bound, example, or exact string the source carried and the draft does not. Quote or name it precisely and say why the draft is still correct without it. An empty array asserts the draft loses nothing.

Every call opens a review turn: the command replies with your draft, its measured size, and your declared losses, then asks for a verdict. Call `rewrite` again to replace the draft, or `approve` to accept it.

<critical>
- Declare losses honestly. A declared loss is a decision the reader can audit; an undeclared one is a silent regression.
- `text` MUST stand alone — a reader who never saw the source MUST be able to execute it.
- A new draft supersedes any earlier approval.
</critical>
