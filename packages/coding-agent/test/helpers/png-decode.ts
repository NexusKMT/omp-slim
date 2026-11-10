import { inflateSync } from "node:zlib";

/** Decoded 8-bit PNG pixels in RGBA order. */
export interface DecodedPng {
	width: number;
	height: number;
	pixels: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an unpaletted, non-interlaced 8-bit PNG into RGBA pixels. */
export function decodePng(buffer: Uint8Array): DecodedPng {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (signature.some((byte, index) => buffer[index] !== byte)) throw new Error("Expected a PNG image");
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Uint8Array[] = [];
	for (let offset = 8; offset + 12 <= buffer.length;) {
		const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
		const length = view.getUint32(0);
		const type = String.fromCharCode(
			buffer[offset + 4]!,
			buffer[offset + 5]!,
			buffer[offset + 6]!,
			buffer[offset + 7]!,
		);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > buffer.length) throw new Error("PNG chunk extends beyond the input");
		if (type === "IHDR") {
			const header = new DataView(buffer.buffer, buffer.byteOffset + dataStart, length);
			width = header.getUint32(0);
			height = header.getUint32(4);
			bitDepth = buffer[dataStart + 8]!;
			colorType = buffer[dataStart + 9]!;
			interlace = buffer[dataStart + 12]!;
		} else if (type === "IDAT") {
			idat.push(buffer.slice(dataStart, dataEnd));
		} else if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}
	if (!width || !height || !idat.length) throw new Error("PNG is missing required image data");
	if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
		throw new Error("PNG comparison supports non-interlaced 8-bit grayscale, RGB, gray-alpha, and RGBA images");
	}
	const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
	const compressed = Buffer.concat(idat.map(chunk => Buffer.from(chunk)));
	const raw = inflateSync(compressed);
	const stride = width * channels;
	if (raw.length !== (stride + 1) * height) throw new Error("PNG scanline data has an unexpected size");
	const unfiltered = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		for (let x = 0; x < stride; x++) {
			const encoded = raw[y * (stride + 1) + x + 1]!;
			const outIndex = y * stride + x;
			const left = x >= channels ? unfiltered[outIndex - channels]! : 0;
			const up = y > 0 ? unfiltered[outIndex - stride]! : 0;
			const upperLeft = y > 0 && x >= channels ? unfiltered[outIndex - stride - channels]! : 0;
			let value: number;
			if (filter === 0) value = encoded;
			else if (filter === 1) value = encoded + left;
			else if (filter === 2) value = encoded + up;
			else if (filter === 3) value = encoded + Math.floor((left + up) / 2);
			else if (filter === 4) value = encoded + paethPredictor(left, up, upperLeft);
			else throw new Error(`Unsupported PNG scanline filter ${filter}`);
			unfiltered[outIndex] = value & 0xff;
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0, out = 0; i < unfiltered.length; i += channels, out += 4) {
		if (colorType === 0) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i]!;
			pixels[out + 2] = unfiltered[i]!;
			pixels[out + 3] = 255;
		} else if (colorType === 2) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i + 1]!;
			pixels[out + 2] = unfiltered[i + 2]!;
			pixels[out + 3] = 255;
		} else if (colorType === 4) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i]!;
			pixels[out + 2] = unfiltered[i]!;
			pixels[out + 3] = unfiltered[i + 1]!;
		} else {
			pixels.set(unfiltered.subarray(i, i + 4), out);
		}
	}
	return { width, height, pixels };
}
