import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDispatcherLock, DEFAULT_DISPATCHER_LOCK_FILE } from "./lock.ts";

function tmpLock(): string {
	return join(mkdtempSync(join(tmpdir(), "dispatcher-lock-")), "dispatcher.lock");
}

describe("dispatcher flock (DISP-01)", () => {
	test("default path is the host lock file, never a tmp path", () => {
		expect(DEFAULT_DISPATCHER_LOCK_FILE).toBe("/var/lib/substrate/dispatcher.lock");
	});

	test("first holder enters, second holder on the same path does not", () => {
		const path = tmpLock();
		const first = acquireDispatcherLock(path);
		try {
			expect(first.held).toBe(true);
			const second = acquireDispatcherLock(path);
			try {
				expect(second.held).toBe(false);
			} finally {
				second.release();
			}
		} finally {
			first.release();
		}
	});

	test("releasing lets the next holder enter, and release is idempotent", () => {
		const path = tmpLock();
		const first = acquireDispatcherLock(path);
		expect(first.held).toBe(true);
		first.release();
		first.release();
		const next = acquireDispatcherLock(path);
		try {
			expect(next.held).toBe(true);
		} finally {
			next.release();
		}
	});
});
