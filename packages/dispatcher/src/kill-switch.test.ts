import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DISPATCHER_ENV_FILE, isDispatchDisabled } from "./kill-switch.ts";

function envFile(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "dispatcher-env-"));
	const path = join(dir, "dispatcher.env");
	writeFileSync(path, body);
	return path;
}

describe("dispatcher kill switch (DISP-01, fail-closed)", () => {
	test("absent file means disabled", () => {
		expect(isDispatchDisabled(join(tmpdir(), `dispatcher-missing-${Date.now()}-${Math.random()}.env`))).toBe(true);
	});

	test("default path is the operator env file, never a tmp path", () => {
		expect(DEFAULT_DISPATCHER_ENV_FILE).toBe("/etc/substrate/dispatcher.env");
	});

	test("absent variable means disabled", () => {
		expect(isDispatchDisabled(envFile("SUBSTRATE_URL=http://127.0.0.1:7410\n"))).toBe(true);
	});

	test("empty file means disabled", () => {
		expect(isDispatchDisabled(envFile(""))).toBe(true);
	});

	test.each(["1", "true", "yes", "TRUE", "Yes", "  yes  ", "maybe", "2", "on"])(
		"disabled value %j stays disabled",
		(value) => {
			expect(isDispatchDisabled(envFile(`SUBSTRATE_DISPATCH_DISABLED=${value}\n`))).toBe(true);
		},
	);

	test.each(["0", "false", "no", "FALSE", "No", "  no  "])("enabled value %j runs", (value) => {
		expect(isDispatchDisabled(envFile(`SUBSTRATE_DISPATCH_DISABLED=${value}\n`))).toBe(false);
	});

	test("empty value means disabled", () => {
		expect(isDispatchDisabled(envFile("SUBSTRATE_DISPATCH_DISABLED=\n"))).toBe(true);
	});

	test("a file change is visible on the next read without restart", () => {
		const path = envFile("SUBSTRATE_DISPATCH_DISABLED=1\n");
		expect(isDispatchDisabled(path)).toBe(true);
		writeFileSync(path, "SUBSTRATE_DISPATCH_DISABLED=no\n");
		expect(isDispatchDisabled(path)).toBe(false);
		writeFileSync(path, "# operator re-armed\nSUBSTRATE_DISPATCH_DISABLED=yes\n");
		expect(isDispatchDisabled(path)).toBe(true);
	});

	test("comments and unrelated lines are ignored, last occurrence wins", () => {
		const path = envFile(
			"# SUBSTRATE_DISPATCH_DISABLED=no\nSUBSTRATE_DISPATCH_DISABLED=1\nSUBSTRATE_DISPATCH_DISABLED=0\n",
		);
		expect(isDispatchDisabled(path)).toBe(false);
	});
});
