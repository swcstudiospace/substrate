import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { crc32, decodePng, decodeXwd, encodePng, pngChunk, PNG_SIGNATURE } from "./png.ts";

/** 4×3 test image: pixel (x, y) is RGB (10x+1, 20y+2, 7x+5y+3). */
const W = 4;
const H = 3;
const pixel = (x: number, y: number) => [10 * x + 1, 20 * y + 2, 7 * x + 5 * y + 3] as const;
const EXPECTED_RGB = Buffer.from(Array.from({ length: W * H }, (_, n) => [...pixel(n % W, Math.floor(n / W))]).flat());

/**
 * A synthetic XWD: big-endian header, window name, ncolors × 12-byte colours, then rows of 4-byte
 * (32 bpp) or packed 3-byte (24 bpp, what this Xvfb's `xwd -root` writes) pixels padded by 4 bytes.
 */
function xwd(o: { byteOrder: 0 | 1; version?: number; format?: number; bpp?: number; ncolors?: number }): Buffer {
	const name = Buffer.from("xwdtest\0");
	const bpp = o.bpp ?? 32;
	const unit = bpp === 24 ? 3 : 4;
	const bytesPerLine = W * unit + 4;
	const header = Buffer.alloc(100);
	const fields = [
		100 + name.length, o.version ?? 7, o.format ?? 2, 24, W, H, 0, o.byteOrder, 32, o.byteOrder, 32, bpp,
		bytesPerLine, 4, 0xff0000, 0xff00, 0xff, 8, 256, o.ncolors ?? 0, W, H, 0, 0, 0,
	];
	fields.forEach((value, i) => header.writeUInt32BE(value, i * 4));
	const pixels = Buffer.alloc(bytesPerLine * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const [r, g, b] = pixel(x, y);
			const at = y * bytesPerLine + x * unit;
			if (o.byteOrder === 0) pixels.writeUIntLE((r << 16) | (g << 8) | b, at, unit);
			else pixels.writeUIntBE((r << 16) | (g << 8) | b, at, unit);
		}
	}
	return Buffer.concat([header, name, Buffer.alloc((o.ncolors ?? 0) * 12), pixels]);
}

function chunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
	const out: Array<{ type: string; data: Buffer; crc: number }> = [];
	for (let at = 8; at < png.length; ) {
		const length = png.readUInt32BE(at);
		out.push({
			type: png.subarray(at + 4, at + 8).toString("latin1"),
			data: png.subarray(at + 8, at + 8 + length),
			crc: png.readUInt32BE(at + 8 + length),
		});
		at += 12 + length;
	}
	return out;
}

describe("decodeXwd", () => {
	test("decodes a 4×3 ZPixmap TrueColor XWD at 32 and packed 24 bpp in either pixel byte order, skipping the colormap", () => {
		for (const bpp of [32, 24]) {
			for (const byteOrder of [0, 1] as const) {
				expect(decodeXwd(xwd({ byteOrder, bpp }))).toEqual({ width: W, height: H, rgb: EXPECTED_RGB });
			}
		}
		expect(decodeXwd(xwd({ byteOrder: 0, bpp: 24, ncolors: 256 })).rgb).toEqual(EXPECTED_RGB);
	});

	test("refuses version 6, XYPixmap, 16 bpp and a truncated buffer", () => {
		expect(() => decodeXwd(xwd({ byteOrder: 0, version: 6 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0, format: 1 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0, bpp: 16 }))).toThrow();
		expect(() => decodeXwd(xwd({ byteOrder: 0 }).subarray(0, 150))).toThrow();
		expect(() => decodeXwd(Buffer.alloc(40))).toThrow();
	});
});

describe("encodePng", () => {
	test("writes signature, IHDR 4×3 depth 8 RGB, CRC-checked chunks and filter-0 rows", () => {
		const png = encodePng(W, H, EXPECTED_RGB);

		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const list = chunks(png);
		expect(list.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
		const ihdr = list[0]!.data;
		expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]]).toEqual([W, H, 8, 2, 0, 0, 0]);
		for (const c of list) expect(c.crc).toBe(crc32(Buffer.concat([Buffer.from(c.type, "latin1"), c.data])));
		expect(list[2]!.crc.toString(16)).toBe("ae426082");

		const raw = inflateSync(list[1]!.data);
		expect(raw.length).toBe(H * (1 + W * 3));
		for (let y = 0; y < H; y++) {
			const row = raw.subarray(y * (1 + W * 3), (y + 1) * (1 + W * 3));
			expect(row[0]).toBe(0);
			expect(row.subarray(1)).toEqual(EXPECTED_RGB.subarray(y * W * 3, (y + 1) * W * 3));
		}
	});
});

describe("decodePng", () => {
	test("round-trips encodePng output exactly", () => {
		const png = encodePng(W, H, EXPECTED_RGB);

		expect(decodePng(png)).toEqual({ width: W, height: H, rgb: EXPECTED_RGB });
	});

	test("refuses a non-zero filter byte", () => {
		const png = encodePng(W, H, EXPECTED_RGB);
		const list = chunks(png);
		const raw = inflateSync(list[1]!.data);
		raw[0] = 1; // first row claims a Sub filter
		const rebuilt = Buffer.concat([
			PNG_SIGNATURE,
			pngChunk("IHDR", list[0]!.data),
			pngChunk("IDAT", deflateSync(raw)),
			pngChunk("IEND", Buffer.alloc(0)),
		]);

		expect(() => decodePng(rebuilt)).toThrow(/filter/);
	});

	test("refuses a bad signature", () => {
		const png = encodePng(W, H, EXPECTED_RGB);
		png[0] = 0x00;

		expect(() => decodePng(png)).toThrow(/signature/);
	});
});
