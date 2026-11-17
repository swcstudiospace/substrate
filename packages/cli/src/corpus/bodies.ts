/**
 * A content-addressed spill directory for document bodies fetched before the plan says which of them must be sent.
 * GitHub bodies arrive during the scan; holding thousands of them in memory is unbounded, so they go to a temporary
 * directory named by their sha256 and are read back one at a time.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

export interface BodyStore {
	put(sha256: string, body: string): void;
	/** The stored text, or null when nothing was stored under that hash. */
	get(sha256: string): string | null;
	/** Removes the directory and everything in it. */
	close(): void;
}

export function createBodyStore(parent: string = tmpdir()): BodyStore {
	const dir = mkdtempSync(join(parent, "substrate-corpus-"));
	const fileFor = (sha256: string): string | null => (SHA256.test(sha256) ? join(dir, sha256) : null);
	return {
		put(sha256, body) {
			const file = fileFor(sha256);
			if (file === null) throw new RangeError("a body is stored under the lowercase hex sha256 of its bytes");
			writeFileSync(file, body, "utf8");
		},
		get(sha256) {
			const file = fileFor(sha256);
			if (file === null) return null;
			try {
				return readFileSync(file, "utf8");
			} catch {
				// Nothing was stored under this hash.
				return null;
			}
		},
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
