// Pack the measured TypeSafe Jev (jev-1.13) vocabulary into one zstd -19 blob of o200k rank bitsets.
//
//   bun tools/pack-jev.ts
//
// Inputs (tools/cache/, gitignored):
//   - o200k_base.tiktoken       — rank source; every Jev piece is an o200k token.
//   - jev-1.13.vocab.json       — {"W": hex[], "B": hex[]} measured against the
//                                  live API (see data/README.md): W = whole-word
//                                  entries, B = base tokens the merge loop may form.
//
// Output: data/jev_sets.bin.zst — two bitsets over the o200k ranks, B (base
// merge set) then W (whole-word set), ceil(O200K / 8) bytes each; rank r is
// bit (r & 7) of byte (r >> 3). The engine merges and looks up through the
// shared o200k rank table, keeping only ranks whose bit is set, so non-members
// can never be produced.

const root = new URL("..", import.meta.url).pathname;
const O200K = 199_998;
const EXPECTED = { W: 144_562, B: 53_622 };

const byHex = new Map<string, number>();
{
	const lines = (await Bun.file(`${root}tools/cache/o200k_base.tiktoken`).text())
		.split("\n")
		.filter(l => l.length > 0);
	if (lines.length !== O200K) throw new Error(`o200k: expected ${O200K} entries, got ${lines.length}`);
	for (let rank = 0; rank < lines.length; rank++) {
		const [b64, rankStr] = lines[rank].split(" ");
		if (Number(rankStr) !== rank) throw new Error(`o200k: rank discontinuity at line ${rank}`);
		byHex.set(Uint8Array.fromBase64(b64).toHex(), rank);
	}
}

const vocab: { W: string[]; B: string[] } = await Bun.file(`${root}tools/cache/jev-1.13.vocab.json`).json();

const SET_BYTES = Math.ceil(O200K / 8);
const bits = new Uint8Array(2 * SET_BYTES);
for (const [set, name, members, expected] of [
	[0, "B", vocab.B, EXPECTED.B],
	[1, "W", vocab.W, EXPECTED.W],
] as const) {
	if (members.length !== expected) throw new Error(`${name}: expected ${expected} entries, got ${members.length}`);
	for (const hex of members) {
		const rank = byHex.get(hex);
		if (rank === undefined) throw new Error(`${name}: ${hex} is not an o200k token`);
		bits[set * SET_BYTES + (rank >> 3)] |= 1 << (rank & 7);
	}
}
const zst = Bun.zstdCompressSync(bits, { level: 19 });
await Bun.write(`${root}data/jev_sets.bin.zst`, zst);
console.log(`jev_sets: ${EXPECTED.B} base + ${EXPECTED.W} whole of ${O200K} ranks, ${bits.length} raw -> ${zst.length} zst`);
