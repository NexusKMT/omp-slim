/**
 * Crossing-inclusive benchmark of native batch vector kernels vs the TS
 * reference loops, at realistic mnemopi recall shapes (fastembed
 * bge-small-en-v1.5, dim=384; binarized stride=48 bytes).
 *
 * Run from the repo root: `bun packages/mnemopi/bench/native-vectors.bench.ts`
 */
import { execSync } from "node:child_process";
import { cosineSimilarityBatch, hammingDistanceBatch, vectorIndexTopK } from "@oh-my-pi/pi-natives";
import { hammingDistance } from "../src/core/binary-vectors";
import { cosineSimilarity } from "../src/core/vector-math";

const DIM = 384;
const STRIDE = DIM / 8;
const COUNTS = [10, 100, 1000, 10000];
const WARMUP = 20;
const ITERATIONS = 200;

function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

let sink = 0;

function timeNs(fn: () => void): number {
	for (let i = 0; i < WARMUP; i += 1) fn();
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i += 1) fn();
	return (Bun.nanoseconds() - start) / ITERATIONS;
}

interface Row {
	kernel: string;
	count: number;
	tsNs: number;
	nativeNs: number;
	speedup: number;
}

const rows: Row[] = [];
const rng = makeRng(0xbe4c4);

for (const count of COUNTS) {
	const query = Float64Array.from({ length: DIM }, () => rng() * 2 - 1);
	const flat = new Float64Array(count * DIM);
	for (let i = 0; i < flat.length; i += 1) flat[i] = rng() * 2 - 1;

	const tsNs = timeNs(() => {
		for (let row = 0; row < count; row += 1) {
			sink += cosineSimilarity(query, flat.subarray(row * DIM, (row + 1) * DIM));
		}
	});
	const nativeNs = timeNs(() => {
		sink += cosineSimilarityBatch(query, flat, DIM)[0] ?? 0;
	});
	rows.push({ kernel: "cosineSimilarityBatch", count, tsNs, nativeNs, speedup: tsNs / nativeNs });
}

for (const count of COUNTS) {
	const matrix = new Float32Array(count * DIM);
	for (let i = 0; i < matrix.length; i += 1) matrix[i] = rng() * 2 - 1;
	const query = Float64Array.from({ length: DIM }, () => rng() * 2 - 1);
	let normSq = 0;
	for (const v of query) normSq += v * v;
	const norm = Math.sqrt(normSq);
	const limit = 10;

	const tsNs = timeNs(() => {
		const hits: Array<{ row: number; score: number }> = [];
		for (let row = 0; row < count; row += 1) {
			let score = 0;
			for (let col = 0; col < DIM; col += 1) {
				score += (matrix[row * DIM + col] ?? 0) * ((query[col] ?? 0) / norm);
			}
			hits.push({ row, score });
		}
		hits.sort((a, b) => b.score - a.score);
		sink += hits[0]?.score ?? 0;
	});
	const nativeNs = timeNs(() => {
		sink += vectorIndexTopK(matrix, DIM, query, limit).scores[0] ?? 0;
	});
	rows.push({ kernel: "vectorIndexTopK", count, tsNs, nativeNs, speedup: tsNs / nativeNs });
}

for (const count of COUNTS) {
	const query = Uint8Array.from({ length: STRIDE }, () => Math.floor(rng() * 256));
	const packed = new Uint8Array(count * STRIDE);
	for (let i = 0; i < packed.length; i += 1) packed[i] = Math.floor(rng() * 256);
	const vectors: Uint8Array[] = [];
	for (let i = 0; i < count; i += 1) vectors.push(packed.subarray(i * STRIDE, (i + 1) * STRIDE));

	const tsNs = timeNs(() => {
		for (let i = 0; i < count; i += 1) sink += hammingDistance(query, vectors[i] ?? new Uint8Array());
	});
	const nativeNs = timeNs(() => {
		sink += hammingDistanceBatch(query, packed, STRIDE)[0] ?? 0;
	});
	rows.push({ kernel: "hammingDistanceBatch", count, tsNs, nativeNs, speedup: tsNs / nativeNs });
}

const sha = execSync("git rev-parse HEAD").toString().trim();
const report = {
	sha,
	date: new Date().toISOString(),
	scenario: `dim=${DIM}, stride=${STRIDE}B, warmup=${WARMUP}, iterations=${ITERATIONS}, crossing-inclusive`,
	runtime: `bun ${Bun.version}`,
	rows: rows.map(r => ({
		kernel: r.kernel,
		count: r.count,
		ts_us: +(r.tsNs / 1000).toFixed(2),
		native_us: +(r.nativeNs / 1000).toFixed(2),
		speedup: +r.speedup.toFixed(2),
	})),
	sink,
};

console.log(JSON.stringify(report, null, 2));
