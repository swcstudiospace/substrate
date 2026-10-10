import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOKENS_DIR, firstLine, resolveBearer } from "./token.ts";

function envOf(entries: Record<string, string>): Record<string, string | undefined> {
	return { ...entries };
}

describe("firstLine", () => {
	test("returns the first line trimmed", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		const file = join(dir, "t");
		writeFileSync(file, "  tok-a\ntok-b\n");
		expect(firstLine(file)).toBe("tok-a");
	});

	test("empty file means no token", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		const file = join(dir, "t");
		writeFileSync(file, "");
		expect(firstLine(file)).toBeNull();
	});

	test("a directory at the path means no token", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		expect(firstLine(dir)).toBeNull();
	});

	test("a missing path means no token", () => {
		expect(firstLine(join(tmpdir(), "tok-no-such-dir", "t"))).toBeNull();
	});

	test("an oversize file means no token", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		const file = join(dir, "t");
		writeFileSync(file, `${"x".repeat(4097)}\n`);
		expect(firstLine(file)).toBeNull();
	});
});

describe("resolveBearer", () => {
	test("env wins over the file and the dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		const file = join(dir, "t");
		writeFileSync(file, "tok-file\n");
		writeFileSync(join(dir, "cursor"), "tok-dir\n");
		const env = envOf({ SUBSTRATE_TOKEN: "tok-env", SUBSTRATE_TOKEN_FILE: file, SUBSTRATE_TOKENS_DIR: dir });
		expect(resolveBearer("cursor", env)).toBe("tok-env");
	});

	test("the token file beats the dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		const file = join(dir, "t");
		writeFileSync(file, "tok-file\n");
		writeFileSync(join(dir, "cursor"), "tok-dir\n");
		const env = envOf({ SUBSTRATE_TOKEN_FILE: file, SUBSTRATE_TOKENS_DIR: dir });
		expect(resolveBearer("cursor", env)).toBe("tok-file");
	});

	test("the dir file is the first line, trimmed", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		writeFileSync(join(dir, "cursor"), "  tok-dir\ntok-other\n");
		expect(resolveBearer("cursor", envOf({ SUBSTRATE_TOKENS_DIR: dir }))).toBe("tok-dir");
	});

	test("an empty dir file means no token", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		writeFileSync(join(dir, "cursor"), "");
		expect(resolveBearer("cursor", envOf({ SUBSTRATE_TOKENS_DIR: dir }))).toBeNull();
	});

	test("an unreadable token file falls back to its configured directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		writeFileSync(join(dir, "cursor"), "tok-dir\n");
		expect(resolveBearer("cursor", envOf({ SUBSTRATE_TOKEN_FILE: dir, SUBSTRATE_TOKENS_DIR: dir }))).toBe("tok-dir");
	});

	test("an oversize dir file means no token", () => {
		const dir = mkdtempSync(join(tmpdir(), "tok-"));
		writeFileSync(join(dir, "cursor"), `${"x".repeat(5000)}\n`);
		expect(resolveBearer("cursor", envOf({ SUBSTRATE_TOKENS_DIR: dir }))).toBeNull();
	});

	test("unsafe surfaces never reach the reader", () => {
		const seen: string[] = [];
		const spy = (path: string): string | null => {
			seen.push(path);
			return "tok-spy";
		};
		for (const surface of ["../x", "a/b", "Cursor", "", "-x", "a..b/../c"]) {
			expect(resolveBearer(surface, envOf({}), spy)).toBeNull();
		}
		expect(seen).toEqual([]);
	});

	test("the built-in dir is used when the variable is unset", () => {
		const seen: string[] = [];
		const spy = (path: string): string | null => {
			seen.push(path);
			return null;
		};
		expect(resolveBearer("cursor", envOf({}), spy)).toBeNull();
		expect(seen).toEqual([join(DEFAULT_TOKENS_DIR, "cursor")]);
	});

	test("absent everywhere means no bearer", () => {
		expect(resolveBearer("cursor", envOf({ SUBSTRATE_TOKENS_DIR: mkdtempSync(join(tmpdir(), "tok-")) }))).toBeNull();
	});
});
