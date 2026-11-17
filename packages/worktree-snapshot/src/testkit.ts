/**
 * Test helpers: real git repositories in temporary directories, a seeded PRNG, a fixed clock and a
 * content hash of a directory. Imported only by tests.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Snapshot } from "./types.ts";

const made: string[] = [];

/** Remove every directory made by `tempDir` and `makeRepo`. Call from `afterAll`. */
export function cleanupTemp(): void {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "substrate-wts-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

export function git(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** A repository with one empty initial commit on `main`, no user excludes, deterministic identity. */
export function makeRepo(): string {
	const dir = tempDir();
	git(dir, ["init", "-q", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Substrate Test"]);
	git(dir, ["config", "core.excludesFile", "/dev/null"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
	return dir;
}

export type FileSpec = string | { content: string; exec?: boolean } | { link: string };

/** Write files (creating directories). A `{link}` spec creates a symlink. Existing paths are replaced. */
export function writeFiles(dir: string, files: Record<string, FileSpec>): void {
	for (const [path, spec] of Object.entries(files)) {
		const absolute = join(dir, path);
		mkdirSync(dirname(absolute), { recursive: true });
		rmSync(absolute, { recursive: true, force: true });
		if (typeof spec === "object" && "link" in spec) {
			symlinkSync(spec.link, absolute);
			continue;
		}
		const content = typeof spec === "string" ? spec : spec.content;
		writeFileSync(absolute, content);
		chmodSync(absolute, typeof spec === "object" && spec.exec ? 0o755 : 0o644);
	}
}

/**
 * A hash of everything under `dir` except `.git`: relative path, kind, executable bit and content
 * (or link target). Two directories with the same hash are byte-for-byte the same file state.
 */
export function dirHash(dir: string): string {
	const hash = createHash("sha256");
	const walk = (relative: string): void => {
		const absolute = join(dir, relative);
		for (const name of readdirSync(absolute).sort()) {
			if (relative === "" && name === ".git") continue;
			const child = relative === "" ? name : `${relative}/${name}`;
			const stat = lstatSync(join(dir, child));
			if (stat.isDirectory()) {
				hash.update(`d ${child}\n`);
				walk(child);
			} else if (stat.isSymbolicLink()) {
				hash.update(`l ${child} ${readlinkSync(join(dir, child))}\n`);
			} else {
				const exec = (stat.mode & 0o100) !== 0 ? "x" : "-";
				const content = createHash("sha256").update(readFileSync(join(dir, child))).digest("hex");
				hash.update(`f ${child} ${exec} ${content}\n`);
			}
		}
	};
	walk("");
	return hash.digest("hex");
}

/** Like `dirHash` but ignores directories that hold no file (git does not track empty directories). */
export function fileStateHash(dir: string): string {
	const hash = createHash("sha256");
	const walk = (relative: string): void => {
		for (const name of readdirSync(join(dir, relative)).sort()) {
			if (relative === "" && name === ".git") continue;
			const child = relative === "" ? name : `${relative}/${name}`;
			const stat = lstatSync(join(dir, child));
			if (stat.isDirectory()) walk(child);
			else if (stat.isSymbolicLink()) hash.update(`l ${child} ${readlinkSync(join(dir, child))}\n`);
			else {
				const exec = (stat.mode & 0o100) !== 0 ? "x" : "-";
				hash.update(`f ${child} ${exec} ${createHash("sha256").update(readFileSync(join(dir, child))).digest("hex")}\n`);
			}
		}
	};
	walk("");
	return hash.digest("hex");
}

/** mulberry32: a small seeded PRNG so property tests are reproducible. */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const FIXED_NOW = (): Date => new Date("2026-01-01T00:00:00.000Z");

/** Assert that every entry of a snapshot is on disk byte-for-byte, with the right mode and type. */
export function expectWorktreeMatches(dir: string, snap: Snapshot): void {
	for (const entry of snap.entries) {
		const absolute = join(dir, entry.path);
		const blob = Bun.spawnSync(["git", "-C", dir, "cat-file", "blob", entry.sha], { stdout: "pipe" }).stdout;
		const stat = lstatSync(absolute);
		if (entry.mode === "120000") {
			expect(stat.isSymbolicLink()).toBe(true);
			expect(Buffer.from(readlinkSync(absolute))).toEqual(Buffer.from(blob));
		} else {
			expect(stat.isFile()).toBe(true);
			expect((stat.mode & 0o100) !== 0).toBe(entry.mode === "100755");
			expect(readFileSync(absolute).equals(Buffer.from(blob))).toBe(true);
		}
	}
}
