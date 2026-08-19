# ctok vocabulary data

`ctok_v3.bin` and `ctok_v4_7.bin` are **generated** — do not hand-edit.
They are compacted from the measured vocabulary files of
[sanderland/ctok](https://github.com/sanderland/ctok) v1.0.0 (revision
`df3b59b5e645289a5eadc8e24036b99d39c333c4`), MIT licensed — see
`LICENSE.ctok`. The vocabulary data is Sander Land's measurement work
("On the biology of Claude's tokenizer",
<https://tokencontributions.substack.com/p/on-the-biology-of-claudes-tokenizer>);
the Rust implementation in the parent directory is this repository's own.

Upstream ships every piece with a `count_tokens` witness probe; compaction
drops that metadata, parses the public `⟨bow⟩the⟨eow⟩` key notation into the
internal marked form — one byte per marker, a third shorter than ctok's
noncharacter spelling in both the pieces and the stream they tile — adds the
glued contraction spellings, and front-codes the sorted piece list into the
binary format documented in `packages/natives/scripts/gen-ctok-vocab.ts`
(~4.7 MB of upstream JSON → ~254 KB embedded).

Regenerate with:

```sh
bun --cwd packages/natives run gen:ctok
```

If the upstream pin moves, also regenerate `../testdata/fixtures.json`
against the same ctok release (see the fixture doc in `../mod.rs`).
