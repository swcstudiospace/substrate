import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, AuditUnavailableError } from "./log.ts";
import type { AuditRecordInput } from "./record.ts";
import { verifyAuditChain } from "./record.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-audit-"));
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
const claim: AuditRecordInput = { surface: "omp", tool: "graph_claim", decision: "allowed", mode: "fail-closed" };

describe("a memory-only chain", () => {
	test("works, verifies, and reports that it is not durable", () => {
		// The local-dev shape. `/healthz` reports `auditDurable: false` so a deployment
		// cannot end up in it by accident.
		const log = new AuditLog({ path: null });
		expect(log.durable).toBe(false);
	});

	test("chains records and lets even a fail-closed call through", async () => {
		const log = new AuditLog({ path: null });
		const first = await log.append(allowed);
		const second = await log.append(claim);

		expect(first.written).toBe(true);
		expect(second.written).toBe(true);
		expect(second.record.prev).toBe(first.record.hash);
		expect(second.record.seq).toBe(2);
		expect((await log.verify()).ok).toBe(true);
	});
});

describe("a file-backed chain", () => {
	test("writes one JSON object per line and verifies end to end", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(allowed);

		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(5);
		expect(await log.verify()).toMatchObject({ ok: true, records: 5, unparseable: 0 });
		expect(log.durable).toBe(true);
	});

	test("creates the parent directory rather than failing on first use", async () => {
		const path = join(temporaryDirectory(), "nested", "deeper", "mcp-audit.jsonl");
		const log = new AuditLog({ path });

		expect(await log.open()).toMatchObject({ durable: true });
		expect((await log.append(allowed)).written).toBe(true);
	});

	test("continues one chain across a restart", async () => {
		// `seq` and `prev` are recovered from the tail, so a restart does not fork the
		// chain — which is what verification would report as a break.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		await first.append(allowed);

		const second = new AuditLog({ path });
		const opened = await second.open();
		expect(opened).toMatchObject({ records: 2, tip: first.tip });

		await second.append(allowed);
		expect((await second.verify())).toMatchObject({ ok: true, records: 3 });
	});

	test("recovers from the last complete line when a write was cut in half", async () => {
		// A process killed mid-write leaves a partial line. Treating it as the tip would
		// chain every later record onto a hash no verifier can recompute. The partial
		// line is left in place — this is append-only, and a reported unparseable line
		// beats a writer that quietly deleted evidence.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		const tip = first.tip;
		appendFileSync(path, '{"seq":2,"ts":"2026-0');

		const second = new AuditLog({ path });
		expect(await second.open()).toMatchObject({ records: 1, tip });

		await second.append(allowed);
		const verdict = await second.verify();
		expect(verdict.unparseable).toBe(1);
	});

	test("the next record after a half-written line is not swallowed by it", async () => {
		// The bug: appending straight onto an unterminated fragment joined the two into
		// one unparseable line, so the new record vanished into it while `append`
		// reported `written: true` — a fail-closed tool would have run with no readable
		// record. Opening terminates the fragment first; the fragment itself is untouched.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		appendFileSync(path, '{"seq":2,"ts":"2026-0'); // no newline: a killed write

		const second = new AuditLog({ path });
		await second.open();
		const result = await second.append(claim);

		expect(result.written).toBe(true);
		const { records, unparseable } = await second.readAll();
		// Two readable records and exactly one bad line — the fragment, not the new record.
		expect(records.map((record) => record.seq)).toEqual([1, 2]);
		expect(unparseable).toBe(1);
		expect(records[1]?.tool).toBe("graph_claim");
	});

	test("the fragment is terminated, not removed", async () => {
		// Deleting it would be a writer erasing evidence from an append-only file.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		appendFileSync(path, '{"seq":2,"partial');

		await new AuditLog({ path }).open();
		expect(readFileSync(path, "utf8")).toContain('{"seq":2,"partial');
	});

	test("an unparseable line fails verification rather than sitting beside an ok verdict", async () => {
		// A record that cannot be read cannot be verified, and "cannot be verified" is
		// not "verified". The evidence bundle reads `ok` alone, so an intact verdict over
		// a file with a hole in it would have been an attestation the data cannot support.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		appendFileSync(path, "not json\n");

		const verdict = await log.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.unparseable).toBe(1);
		expect((verdict as { reason: string }).reason).toContain("could not be parsed");
	});

	test("a tampered record is named ahead of an unparseable line", async () => {
		// A hash mismatch names a specific position, which is the more useful answer; the
		// unparseable count cannot name one.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		const first = await log.append(allowed);
		writeFileSync(path, `${JSON.stringify({ ...first.record, decision: "denied" })}\nnot json\n`);

		const verdict = await log.verify();
		expect(verdict).toMatchObject({ ok: false, brokenAt: 1, reason: "hash does not match contents" });
	});

	test("recovers from a tail window that starts mid-line", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		for (let i = 0; i < 20; i++) await first.append(allowed);

		// A window far smaller than the file, so it necessarily starts mid-record.
		const second = new AuditLog({ path, tailBytes: 900 });
		expect(await second.open()).toMatchObject({ records: 20, tip: first.tip });
	});

	test("an empty file is a fresh chain, not a broken one", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		writeFileSync(path, "");
		const log = new AuditLog({ path });

		expect(await log.open()).toMatchObject({ records: 0, tip: null });
		expect((await log.append(allowed)).record.seq).toBe(1);
	});

	test("readAll counts lines it cannot parse instead of throwing", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		appendFileSync(path, "not json\n");

		const { records, unparseable } = await log.readAll();
		expect(records).toHaveLength(1);
		expect(unparseable).toBe(1);
	});

	test("what lands on disk is what a fresh verifier recomputes", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append({ ...allowed, args: { graph_id: "ut-1" } });
		await log.append({ ...claim, reason: "why not" });

		const parsed = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(verifyAuditChain(parsed)).toEqual({ ok: true, records: 2 });
	});
});

describe("when the sink refuses the write", () => {
	/**
	 * A path the process cannot possibly create: its parent is a regular file, so
	 * both `mkdirSync` and `appendFileSync` fail with ENOTDIR. Structural rather than
	 * permission-based, because the test runner may be root — where `chmod 0500`
	 * denies nothing and the test would silently pass for the wrong reason.
	 */
	function unwritablePath(): string {
		const directory = temporaryDirectory();
		writeFileSync(join(directory, "not-a-directory"), "");
		return join(directory, "not-a-directory", "mcp-audit.jsonl");
	}

	test("open reports that the chain is not durable, at boot rather than on first claim", async () => {
		const log = new AuditLog({ path: unwritablePath() });
		const opened = await log.open();

		expect(opened.durable).toBe(false);
		expect(opened.error).toBeDefined();
		expect(log.durable).toBe(false);
	});

	test("a fail-open call proceeds and is told the record was lost", async () => {
		// Reads and `events_emit` sit inside a prompt's hook budget. An unwritable audit
		// file is not a reason for an agent's turn to fail.
		const log = new AuditLog({ path: unwritablePath() });
		await log.open();

		const result = await log.append(allowed);
		expect(result.written).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("a fail-closed call throws, so the caller must deny it", async () => {
		const log = new AuditLog({ path: unwritablePath() });
		await log.open();

		await expect(log.append(claim)).rejects.toBeInstanceOf(AuditUnavailableError);
	});

	test("the chain does not advance on a failed write", async () => {
		// Advancing it would leave every later record pointing at a hash that is not in
		// the file, so one unwritable record would break verification for everything
		// after it. Both attempts are therefore offered the same position.
		const log = new AuditLog({ path: unwritablePath() });
		await log.open();

		const first = await log.append(allowed);
		const second = await log.append(allowed);

		expect(first.record.seq).toBe(1);
		expect(second.record.seq).toBe(1);
		expect(second.record.prev).toBeNull();
		expect(log.seq).toBe(0);
		expect(log.tip).toBeNull();
	});

	test("the failed record still has a hash, so the attempt can be reported", async () => {
		const log = new AuditLog({ path: unwritablePath() });
		await log.open();
		const result = await log.append(allowed);

		expect(result.record.hash).toHaveLength(64);
		expect(result.record.decision).toBe("allowed");
	});

	test("the error is redacted, because a filesystem error quotes a path", async () => {
		const log = new AuditLog({ path: unwritablePath(), redact: (text) => text.replace(/\/tmp\/\S+/g, "[PATH]") });
		await log.open();

		expect((await log.append(allowed)).error).not.toContain("/tmp/");
	});
});

describe("recent", () => {
	test("returns the newest records, bounded", async () => {
		const log = new AuditLog({ path: null, maxRetained: 3 });
		for (let i = 0; i < 10; i++) await log.append(allowed);

		expect(log.recent(100)).toHaveLength(3);
		expect(log.recent(100).map((record) => record.seq)).toEqual([8, 9, 10]);
		expect(log.recent(2).map((record) => record.seq)).toEqual([9, 10]);
	});
});

describe("append before open", () => {
	test("opens the chain on first use rather than losing the record", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });

		expect((await log.append(allowed)).written).toBe(true);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
	});
});
