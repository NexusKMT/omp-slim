# TLA+ / PlusCal grammar fixture

`tlaplus-2bb6711906017f86.wasm.zst` is the unmodified compressed grammar from
[stencil-hq/wasm-grammars v1](https://github.com/stencil-hq/wasm-grammars/releases/download/v1/tlaplus-2bb6711906017f86.wasm.zst),
built from [tree-sitter-tlaplus 1.5.0](https://crates.io/crates/tree-sitter-tlaplus/1.5.0).
The upstream grammar uses the MIT license, reproduced in `LICENSE.tlaplus`
from [its packaged source revision](https://github.com/tlaplus-community/tree-sitter-tlaplus/blob/8a8413f1d08e7ee40b347206d26eac4324db9fd9/LICENSE).

The decompressed module is 4,878,580 bytes, with SHA-256
`2bb6711906017f861d3c143553c5077fc167f29d023a606a5dcfc159efb9e5bc`.
These values match the native `wasmGrammarFor` manifest and are verified before
the test installs the fixture into its temporary directory.

The AST grep alias and AST edit tests parse this actual grammar in separate
processes, with grammar downloads directed to an unavailable loopback endpoint. This preserves
real TLA+ / PlusCal parsing coverage without requiring GitHub network access or
an existing user cache. Download verification and failure handling are covered
separately by `test/utils/grammars.test.ts`.
