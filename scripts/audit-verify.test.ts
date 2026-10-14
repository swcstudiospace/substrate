import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, listAuditSegments, segmentPath } from "../packages/audit/src/log.ts";
import type { AuditRecordInput } from "../packages/audit/src/record.ts";
import { formatReport, parseArgs, run, VerifyUsageError } from "./audit-verify.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-audit-verify-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

const allowed: AuditRecordInput = { surface: "omp", tool: "graph_get", decision: "allowed", mode: "fail-open" };

describe("arguments", () => {
	test("--path wins, SUBSTRATE_AUDIT_PATH is the default, and neither is a usage error", () => {
		expect(parseArgs(["--path", "/tmp/a.jsonl"], { SUBSTRATE_AUDIT_PATH: "/var/lib/substrate/mcp-audit.jsonl" })).toEqual({ path: "/tmp/a.jsonl" });
		expect(parseArgs([], { SUBSTRATE_AUDIT_PATH: "/var/lib/substrate/mcp-audit.jsonl" })).toEqual({ path: "/var/lib/substrate/mcp-audit.jsonl" });
		expect(() => parseArgs([], {})).toThrow(VerifyUsageError);
		expect(() => parseArgs([], { SUBSTRATE_AUDIT_PATH: "  " })).toThrow("no audit file");
		expect(() => parseArgs(["--path"], {})).toThrow("--path needs a value");
		expect(() => parseArgs(["--path", "--help"], {})).toThrow("--path needs a value");
		expect(() => parseArgs(["--verbose"], {})).toThrow("unknown argument --verbose");
		expect(() => parseArgs(["--help"], {})).toThrow("usage:");
	});
});

describe("output shape", () => {
	test("a verified chain prints the five fields in order and nothing else", () => {
		expect(formatReport({ segments: 2, records: 5, firstSeq: 1, lastSeq: 5, ok: true, unparseable: 0 })).toBe(
			'{"segments":2,"records":5,"firstSeq":1,"lastSeq":5,"ok":true}\n',
		);
	});

	test("a broken chain adds the position and the reason", () => {
		const line = formatReport({
			segments: 1,
			records: 4,
			firstSeq: 1,
			lastSeq: 4,
			ok: false,
			unparseable: 1,
			brokenAt: 3,
			reason: "prev does not match the preceding record",
		});
		expect(JSON.parse(line)).toEqual({
			segments: 1,
			records: 4,
			firstSeq: 1,
			lastSeq: 4,
			ok: false,
			unparseable: 1,
			brokenAt: 3,
			reason: "prev does not match the preceding record",
		});
	});

	test("an empty chain is a verified chain of nothing", () => {
		expect(JSON.parse(formatReport({ segments: 0, records: 0, firstSeq: null, lastSeq: null, ok: true, unparseable: 0 }))).toEqual({
			segments: 0,
			records: 0,
			firstSeq: null,
			lastSeq: null,
			ok: true,
		});
	});
});

describe("segment ordering", () => {
	test("segments are walked by sequence, whatever order the directory lists them in", () => {
		const dir = temporaryDirectory();
		const path = join(dir, "mcp-audit.jsonl");
		for (const [first, last] of [
			[9001, 18000],
			[1, 9000],
			[18001, 20000],
		] as const) {
			writeFileSync(segmentPath(path, first, last), "");
		}
		writeFileSync(path, "");
		writeFileSync(`${path}.checkpoint`, "");
		writeFileSync(join(dir, "mcp-audit.jsonl.bak"), "");
		expect(readdirSync(dir)).toHaveLength(6);
		expect(listAuditSegments(path).map((segment) => [segment.firstSeq, segment.lastSeq])).toEqual([
			[1, 9000],
			[9001, 18000],
			[18001, 20000],
		]);
	});
});

describe("run", () => {
	/** A chain rolled into two closed segments of two records and an active file of one, as the service would write it. */
	async function rolledChain(): Promise<string> {
		const now = () => new Date("2026-10-13T12:00:00.000Z");
		// Record size past the first is steady under a fixed clock and single-digit seq.
		const probePath = join(temporaryDirectory(), "probe.jsonl");
		const probe = new AuditLog({ path: probePath, now, rolloverBytes: null });
		await probe.open();
		await probe.append(allowed);
		const head = statSync(probePath).size;
		await probe.append(allowed);
		const size = statSync(probePath).size - head;

		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(allowed);
		expect(listAuditSegments(path).map((segment) => [segment.firstSeq, segment.lastSeq])).toEqual([
			[1, 2],
			[3, 4],
		]);
		return path;
	}

	test("verifies across segments, exits 0, and prints no record field", async () => {
		const path = await rolledChain();
		const { code, out } = await run(["--path", path], {});
		expect(code).toBe(0);
		const report = JSON.parse(out);
		expect(report).toMatchObject({ records: 5, firstSeq: 1, lastSeq: 5, ok: true });
		expect(report.segments).toBe(listAuditSegments(path).length);
		expect(out).not.toContain("graph_get");
		expect(out).not.toContain("omp");
	});

	test("a chain missing a segment exits 1 with the reason", async () => {
		const path = await rolledChain();
		const [first] = listAuditSegments(path);
		rmSync(first?.path ?? "");
		const { code, out } = await run(["--path", path], {});
		expect(code).toBe(1);
		expect(JSON.parse(out)).toMatchObject({ ok: false });
		expect(out).toContain("does not open at seq 1");
	});

	test("a checkpoint past the files is missing history, exit 1", async () => {
		const path = await rolledChain();
		for (const segment of listAuditSegments(path)) rmSync(segment.path);
		rmSync(path);
		const { code, out } = await run([], { SUBSTRATE_AUDIT_PATH: path });
		expect(code).toBe(1);
		expect(JSON.parse(out)).toMatchObject({ ok: false, segments: 0, records: 0 });
		expect(out).toContain("missing history");
	});

	test("verifying never writes", async () => {
		const path = await rolledChain();
		const before = readdirSync(join(path, "..")).sort();
		await run(["--path", path], {});
		expect(readdirSync(join(path, "..")).sort()).toEqual(before);
	});
});
