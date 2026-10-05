# utok vocabulary data

`ctok_v3.bin.zst` and `ctok_v4_7.bin.zst` are **generated** — do not
hand-edit. They are compacted from the measured vocabulary files of
[sanderland/ctok](https://github.com/sanderland/ctok) v1.0.0 (revision
`df3b59b5e645289a5eadc8e24036b99d39c333c4`), MIT licensed — see
`LICENSE.ctok`. The vocabulary data is Sander Land's measurement work
("On the biology of Claude's tokenizer",
<https://tokencontributions.substack.com/p/on-the-biology-of-claudes-tokenizer>);
the Rust implementation in `../src/utok/claude/` is this repository's own.

Upstream ships every piece with a `count_tokens` witness probe; compaction
drops that metadata, parses the public `⟨bow⟩the⟨eow⟩` key notation into the
compact C0 marker alphabet (single bytes `0x01`–`0x05`; safe because `nfc`
strips C0 controls from input), adds the glued contraction spellings, and
front-codes the sorted piece list into the version-2 binary format produced
by `../tools/gen-ctok-vocab.ts` (~4.7 MB of upstream JSON →
~254 KB front-coded → ~106 KB after zstd -19).

Regenerate the front-coded binaries, then compress them here:

```sh
cd ../tools
bun gen-ctok-vocab.ts   # fetch upstream, emit raw bins into cache/
bun pack-ctok.ts        # zstd -19 into ../data/
```

If the upstream pin moves, also regenerate
`../src/utok/claude/testdata/fixtures.json` against the same ctok release
(see the fixture doc in `../src/utok/claude/mod.rs`).

The other `*.bin.zst` files here are the UTOK1 BPE rank tables packed by
the per-family scripts in `../tools/` (container format and per-family
split specs: `families.json` in this directory).

`jev_sets.bin.zst` is **measured**, not downloaded: TypeSafe publishes no
tokenizer for Jev, so both of its sets were recovered from the live System
One API's `usage.input_tokens` (jev-1.13.0, 2026-09-23, ~639k probes). The
whole-word set holds the entries a piece costs 1 by equalling; the base set
holds the tokens the merge loop may form. Both are o200k subsets, stored as
two bitsets over the o200k ranks (base, then whole) that filter the shared
`o200k_base` table. Membership came from difference probes inside
non-merging padding (e.g. `cost("世" + x + "世") - 2`), byte fragments were
fitted against per-character probes, and pieces padding cannot isolate
(space runs, newline-final punctuation, rare fragments) were settled with
probes built to flip on each one. The result reproduces all 638,573
recorded counts (`fixtures/jev.json` pins 400 live counts). Regenerate the
blob from the measured sets with:

```sh
cd ../tools
bun pack-jev.ts   # cache/jev-1.13.vocab.json + cache/o200k_base.tiktoken → ../data/jev_sets.bin.zst
```
