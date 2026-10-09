/**
 * desktop_run's image codec (DESK-01 / D30-09): XWD decode and PNG encode, split out of the
 * driver. Screenshots arrive as XWD (`xwd -root -silent`) and are stored and returned as PNG.
 * Decoding back (`decodePng`) is filter-0 only — exactly what `encodePng` writes — and refuses
 * anything else. No new dependency: `node:zlib` only.
 */
import { deflateSync, inflateSync } from "node:zlib";

// ── XWD → RGB ────────────────────────────────────────────────────────────────

const XWD_HEADER_BYTES = 100;
const XWD_COLOR_BYTES = 12;
const ZPIXMAP = 2;
const TRUE_COLOR = 4;
const DIRECT_COLOR = 5;

/**
 * Decode an X Window Dump: header CARD32s are big-endian, pixels are in the file's byte_order,
 * channels come from the red/green/blue masks. Only version 7, ZPixmap, TrueColor or DirectColor,
 * at 32 bpp or packed 24 bpp — the webtop's Xvfb (`-screen 0 1280x800x24`) makes `xwd -root` write
 * 24 bpp: 3-byte pixels in 5,120-byte scanlines.
 */
export function decodeXwd(buf: Buffer): { width: number; height: number; rgb: Buffer } {
	if (buf.length < XWD_HEADER_BYTES) throw new Error("xwd: shorter than its header");
	const field = (i: number) => buf.readUInt32BE(i * 4);
	const headerSize = field(0);
	const version = field(1);
	const format = field(2);
	const width = field(4);
	const height = field(5);
	const byteOrder = field(7);
	const bpp = field(11);
	const bytesPerLine = field(12);
	const visualClass = field(13);
	const ncolors = field(19);
	if (version !== 7) throw new Error(`xwd: version ${version}, expected 7`);
	if (format !== ZPIXMAP) throw new Error(`xwd: pixmap format ${format}, expected ZPixmap`);
	if (bpp !== 32 && bpp !== 24) throw new Error(`xwd: ${bpp} bits per pixel, expected 32 or 24`);
	const unit = bpp / 8;
	if (visualClass !== TRUE_COLOR && visualClass !== DIRECT_COLOR) throw new Error(`xwd: visual class ${visualClass}`);
	if (byteOrder > 1) throw new Error(`xwd: byte order ${byteOrder}`);
	if (headerSize < XWD_HEADER_BYTES || width === 0 || height === 0 || bytesPerLine < width * unit) {
		throw new Error("xwd: inconsistent header");
	}
	const offset = headerSize + ncolors * XWD_COLOR_BYTES;
	if (buf.length < offset + bytesPerLine * height) throw new Error("xwd: truncated pixel data");

	const channels = [field(14), field(15), field(16)].map((mask) => {
		if (mask === 0) throw new Error("xwd: empty colour mask");
		const shift = 31 - Math.clz32(mask & -mask);
		return { mask, shift, max: mask >>> shift };
	});
	const littleEndian = byteOrder === 0;
	const rgb = Buffer.allocUnsafe(width * height * 3);
	let out = 0;
	for (let y = 0; y < height; y++) {
		let at = offset + y * bytesPerLine;
		for (let x = 0; x < width; x++, at += unit) {
			const pixel = littleEndian ? buf.readUIntLE(at, unit) : buf.readUIntBE(at, unit);
			for (const { mask, shift, max } of channels) {
				const value = (pixel & mask) >>> shift;
				rgb[out++] = max === 255 ? value : Math.round((value * 255) / max);
			}
		}
	}
	return { width, height, rgb };
}

// ── RGB → PNG ────────────────────────────────────────────────────────────────

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

/** IEEE CRC-32, as PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
	return chunk;
}

/** An 8-bit RGB PNG: signature, IHDR, one IDAT of deflated filter-0 rows, IEND. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
	const stride = width * 3;
	if (rgb.length !== stride * height) throw new Error(`png: ${rgb.length} bytes for ${width}x${height} RGB`);
	const rows = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) rgb.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type RGB; compression, filter and interlace stay 0
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

// ── PNG → RGB (filter-0 only) ────────────────────────────────────────────────

/**
 * Decode the PNGs `encodePng` writes: 8-bit RGB, non-interlaced, every row filter 0.
 * Anything else — another bit depth, colour type, interlace method, or a non-zero
 * filter byte on any row — is refused. Shared by the tests, the N1 spike and the smoke.
 */
export function decodePng(png: Buffer): { width: number; height: number; rgb: Buffer } {
	if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("png: bad signature");
	let width = 0;
	let height = 0;
	const idat: Buffer[] = [];
	for (let at = 8; at < png.length; ) {
		const len = png.readUInt32BE(at);
		const type = png.toString("latin1", at + 4, at + 8);
		const data = png.subarray(at + 8, at + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("png: not 8-bit RGB non-interlaced");
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		at += 12 + len;
	}
	const rows = inflateSync(Buffer.concat(idat));
	const stride = width * 3;
	if (rows.length !== height * (stride + 1)) throw new Error("png: size mismatch");
	const rgb = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		if (rows[y * (stride + 1)] !== 0) throw new Error(`png: row ${y} filter ${rows[y * (stride + 1)]}`);
		rows.copy(rgb, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
	}
	return { width, height, rgb };
}
