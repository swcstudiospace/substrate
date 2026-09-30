import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, AuditUnavailableError } from "./log.ts";
import type { AuditRecordInput } from "./record.ts";
import { MAX_ARG_KEY, MAX_ARG_KEYS, MAX_RECORD_BYTES, MAX_TOOL_NAME, verifyAuditChain } from "./record.ts";

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

	test("a chain past its retention window still verifies — it never claimed to start at seq 1", async () => {
		// The genesis check is about a *file*, which holds every record ever appended.
		// Memory answers from a bounded tail, so requiring `seq: 1` of it reported every
		// local-dev process past its retention as a broken chain — a false alarm in the
		// same bundle that check exists to protect.
		const log = new AuditLog({ path: null, maxRetained: 3 });
		for (let i = 0; i < 10; i++) await log.append(allowed);

		expect(log.recent(100).map((record) => record.seq)).toEqual([8, 9, 10]);
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

describe("a deleted or truncated audit file", () => {
	// The checkpoint beside the file is what makes "no records" two different answers.
	// Without it, a deployment whose audit file was removed restarted at seq 1, the new
	// chain verified as intact, and an evidence bundle attested to it without a word
	// about the decisions that had gone — which is the one failure an audit cannot have,
	// because the reader of an evidence document has nothing else to go on.

	test("a fresh install has no history to be missing", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		const opened = await log.open();

		expect(opened.missingHistory).toBeUndefined();
		expect(log.missingHistory).toBeNull();
		await log.append(allowed);
		expect((await log.verify()).ok).toBe(true);
	});

	test("a checkpoint is written beside the file as the chain advances", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		await log.append(claim);

		const checkpoint = JSON.parse(readFileSync(`${path}.checkpoint`, "utf8")) as { seq: number; hash: string };
		expect(checkpoint.seq).toBe(2);
		expect(checkpoint.hash).toBe(log.tip as string);
	});

	test("a deleted file is reported as missing history, not accepted as a fresh chain", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		await first.append(claim);

		rmSync(path);

		const second = new AuditLog({ path });
		const opened = await second.open();
		expect(opened.missingHistory).toEqual({ checkpointSeq: 2, foundSeq: 0 });

		const verdict = await second.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("missing history");
	});

	test("a truncated file is reported the same way", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		for (let i = 0; i < 4; i++) await first.append(allowed);

		// Keep only the first two lines: the survivors are internally consistent and open
		// at seq 1, so nothing in the file itself is wrong. Only the checkpoint knows.
		const kept = readFileSync(path, "utf8").trim().split("\n").slice(0, 2);
		writeFileSync(path, `${kept.join("\n")}\n`);

		const second = new AuditLog({ path });
		expect((await second.open()).missingHistory).toEqual({ checkpointSeq: 4, foundSeq: 2 });
		const verdict = await second.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("2 earlier decision(s) are not in it");
	});

	test("the chain resumes from the checkpoint rather than reusing a seq", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		await first.append(allowed);
		rmSync(path);

		const second = new AuditLog({ path });
		await second.open();
		const next = await second.append(claim);

		// Not seq 1. Reusing a sequence number would make the loss unprovable from the
		// file, and the genesis check now reports the gap on the file's own terms too.
		expect(next.record.seq).toBe(3);
		expect((await second.verify()).ok).toBe(false);
	});

	test("appending still works, because an audit must not become an outage", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(claim);
		rmSync(path);

		const second = new AuditLog({ path });
		await second.open();
		// A fail-closed call is still recorded and still allowed: refusing every claim
		// forever after a disk mishap would be an outage in the name of an audit.
		expect((await second.append(claim)).written).toBe(true);
	});

	test("an unreadable checkpoint raises no alarm of its own", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		writeFileSync(`${path}.checkpoint`, "{ not json");

		const second = new AuditLog({ path });
		expect((await second.open()).missingHistory).toBeUndefined();
		expect((await second.verify()).ok).toBe(true);
	});

	test("checkpointPath: false keeps the pre-checkpoint behaviour, and cannot detect the loss", async () => {
		// Pinned so the checkpoint's job is visible: this is what the code did before it,
		// and it is exactly the state Greptile's finding describes.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path, checkpointPath: false });
		await first.open();
		await first.append(allowed);
		rmSync(path);

		const second = new AuditLog({ path, checkpointPath: false });
		await second.open();
		await second.append(allowed);
		expect((await second.verify()).ok).toBe(true);
	});
});

describe("a record larger than the recovery window", () => {
	// A 64 KiB tail assumed the last record fit in it, and `params.name` in a JSON-RPC
	// envelope is a caller-supplied string, so the size was the caller's to choose. If
	// that record was last, recovery found nothing and the writer restarted at seq 1 on
	// top of a file that already held a chain — so every later fail-closed call appended
	// to something no verifier could reconstruct.

	test("a record is size-bounded however long the caller's arguments are", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		const args: Record<string, unknown> = {};
		// Distinct names, each too long: capped one by one, then capped in number.
		for (let i = 0; i < 500; i++) args[`${i}-${"k".repeat(400)}`] = "v";
		const written = await log.append({ ...allowed, tool: "x".repeat(5000), args });

		expect(JSON.stringify(written.record).length).toBeLessThan(MAX_RECORD_BYTES);
		expect(written.record.tool).toHaveLength(MAX_TOOL_NAME);
		expect(written.record.arg_keys).toHaveLength(MAX_ARG_KEYS);
		expect(written.record.arg_keys.every((key) => key.length <= MAX_ARG_KEY)).toBe(true);
	});

	test("the recovery window is never smaller than the largest record", () => {
		// Asked for 512 bytes and it does not get them: a window below the record bound
		// would make "the last record did not fit" reachable again by a caller.
		const log = new AuditLog({ path: null, tailBytes: 512 });
		expect(log).toBeDefined();
	});

	test("recovery scans past the tail window for a long line rather than restarting", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append(allowed);
		// A line no window this size can hold whole, written by something other than this
		// writer — which is the case the expanding scan exists for.
		appendFileSync(path, `${JSON.stringify({ filler: "z".repeat(300_000) })}\n`);
		const last = await first.append(claim);

		const second = new AuditLog({ path, tailBytes: 1024 });
		const opened = await second.open();
		expect(opened.records).toBe(last.record.seq);
		expect(opened.tip).toBe(last.record.hash);
	});

	test("a file with no readable record at all refuses to append rather than restart", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		writeFileSync(path, "this is not an audit record at all\n");

		const log = new AuditLog({ path });
		const opened = await log.open();
		expect(opened.durable).toBe(false);
		expect(opened.error).toContain("no readable audit record");

		// Fail-closed refused, fail-open recorded as lost: what the position being unknown
		// actually means, rather than a seq 1 written on top of somebody's chain.
		expect(log.append(claim)).rejects.toThrow(AuditUnavailableError);
		expect((await log.append(allowed)).written).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("this is not an audit record at all\n");
	});
});

describe("a line that is valid JSON but is not a record", () => {
	test("verification reports a broken chain rather than throwing", async () => {
		// `null` parses. Verification then read `.hash` off it and threw, so `/evidence`
		// answered 500 instead of telling the operator the audit file was corrupt.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		appendFileSync(path, "null\n");

		const verdict = await log.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("is not an audit record");
	});

	test("so does a bare array, and a record missing its hash", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append(allowed);
		appendFileSync(path, `[1,2]\n${JSON.stringify({ seq: 2, prev: null })}\n`);

		expect((await log.verify()).ok).toBe(false);
	});

	test("boot does not continue the chain from one either", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		const real = await first.append(allowed);
		appendFileSync(path, "null\n");

		const second = new AuditLog({ path });
		const opened = await second.open();
		expect(opened.tip).toBe(real.record.hash);
	});
});

describe("verifiedView", () => {
	test("returns the verdict and one graph's records from a single pass", async () => {
		// Two reads and two parses per `/evidence` request, of a file with no compaction,
		// was a cost that grew with the trail on a process every prompt on the host waits
		// for. One pass, and only this graph's records held.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append({ ...allowed, graph_id: "ut-1" });
		await log.append({ ...allowed, graph_id: "ut-2" });
		await log.append({ ...claim, graph_id: "ut-1" });
		await log.append(allowed);

		const view = await log.verifiedView("ut-1");
		expect(view.verdict).toEqual({ ok: true, records: 4, unparseable: 0 });
		expect(view.total).toBe(4);
		expect(view.records.map((record) => record.seq)).toEqual([1, 3]);
	});

	test("bounds how many records it collects, and still counts them all", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 6; i++) await log.append({ ...allowed, graph_id: "ut-1" });

		const view = await log.verifiedView("ut-1", 2);
		expect(view.records).toHaveLength(2);
		expect(view.total).toBe(6);
		expect(view.verdict.records).toBe(6);
	});

	test("carries the same missing-history verdict verify does", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append({ ...allowed, graph_id: "ut-1" });
		rmSync(path);

		const second = new AuditLog({ path });
		await second.open();
		await second.append({ ...allowed, graph_id: "ut-1" });
		expect((await second.verifiedView("ut-1")).verdict.ok).toBe(false);
	});

	test("a long line split across stream chunks is still read whole", async () => {
		// The line reader's remainder buffer. A record straddling a chunk boundary that
		// arrived as two fragments would count as two unparseable lines.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		await log.append({ ...allowed, graph_id: "ut-1", args: { note: "x".repeat(200_000) } });

		const view = await log.verifiedView("ut-1");
		expect(view.verdict).toEqual({ ok: true, records: 1, unparseable: 0 });
		expect(view.records).toHaveLength(1);
	});
});
