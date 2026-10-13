import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuditLog,
	AuditUnavailableError,
	MAX_WALK_ATTEMPTS,
	listAuditSegments,
	orderSegments,
	parseSegmentName,
	rolloverBytesFromEnv,
	segmentPath,
	verifyAuditSegments,
	walkAuditFiles,
} from "./log.ts";
import type { AuditRecordInput } from "./record.ts";
import {
	ChainWalker,
	buildRecord,
	MAX_ARG_KEY,
	MAX_ARG_KEYS,
	MAX_RECORD_BYTES,
	MAX_TALLY_KEYS,
	MAX_TOOL_NAME,
	TALLY_OVERFLOW,
	verifyAuditChain,
} from "./record.ts";

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
		expect(opened.missingHistory).toEqual({ kind: "missing", checkpointSeq: 2, foundSeq: 0 });

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
		expect((await second.open()).missingHistory).toEqual({ kind: "missing", checkpointSeq: 4, foundSeq: 2 });
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

describe("a rewritten audit file", () => {
	// The checkpoint holds the committed *hash*, not just the count. Comparing sequence
	// numbers alone accepted a file replaced with a different, internally consistent chain
	// ending at the same seq — and the next append then rewrote the checkpoint to match the
	// impostor, so the substitution erased its own evidence.

	/** A valid chain of `count` records written from scratch, with a marker in each. */
	async function chainInto(path: string, count: number, surface: string): Promise<AuditLog> {
		const log = new AuditLog({ path, checkpointPath: false });
		await log.open();
		for (let i = 0; i < count; i++) await log.append({ ...allowed, surface });
		return log;
	}

	test("is reported as rewritten, not accepted because the count matches", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const real = new AuditLog({ path });
		await real.open();
		for (let i = 0; i < 3; i++) await real.append({ ...allowed, surface: "omp" });

		// Replace the file with a different chain of the same length. It verifies on its
		// own terms: opens at seq 1, every hash and prev follows.
		const impostor = join(temporaryDirectory(), "impostor.jsonl");
		await chainInto(impostor, 3, "muse");
		writeFileSync(path, readFileSync(impostor, "utf8"));

		const reopened = new AuditLog({ path });
		const opened = await reopened.open();
		expect(opened.missingHistory).toEqual({ kind: "rewritten", checkpointSeq: 3, foundSeq: 3 });

		const verdict = await reopened.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("replaced with a different chain");
	});

	test("and the next append does not launder the checkpoint", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const real = new AuditLog({ path });
		await real.open();
		await real.append({ ...allowed, surface: "omp" });

		const impostor = join(temporaryDirectory(), "impostor.jsonl");
		await chainInto(impostor, 1, "muse");
		writeFileSync(path, readFileSync(impostor, "utf8"));

		const reopened = new AuditLog({ path });
		await reopened.open();
		await reopened.append(claim);
		// Still broken after appending: the chain resumed from the checkpoint's hash, so the
		// new record's `prev` does not follow the impostor's record.
		expect((await reopened.verify()).ok).toBe(false);
	});

	test("a substitution while the process runs is caught by the anchor on the next verify", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		await first.append({ ...allowed, surface: "omp" });
		await first.append({ ...allowed, surface: "omp" });

		// A second process opens it — its anchor is the checkpoint at seq 2 — and then the
		// file's earlier records are swapped out underneath it.
		const second = new AuditLog({ path });
		await second.open();
		const impostor = join(temporaryDirectory(), "impostor.jsonl");
		await chainInto(impostor, 2, "muse");
		writeFileSync(path, readFileSync(impostor, "utf8"));

		const verdict = await second.verify();
		expect(verdict.ok).toBe(false);
		expect(second.missingHistory?.kind).toBe("rewritten");
	});

	test("an untouched file still verifies across a restart", async () => {
		// The anchor must not cry wolf on the ordinary case, which is every restart.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path });
		await first.open();
		for (let i = 0; i < 3; i++) await first.append(allowed);

		const second = new AuditLog({ path });
		expect((await second.open()).missingHistory).toBeUndefined();
		await second.append(claim);
		expect((await second.verify()).ok).toBe(true);
		expect(second.missingHistory).toBeNull();
	});
});

describe("verifiedView selects the way the records were stored", () => {
	const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
	const secret = `sk-ant-${"a".repeat(30)}`;

	test("a graph whose id the audit redacts still finds its own records", async () => {
		// `buildRecord` redacts `graph_id` like every other stored field, so selecting on the
		// raw identifier matched none of the graph's own records and its evidence bundle
		// silently omitted every decision made about it. The ledger already normalises its
		// query for the same reason — `verifyGraph` reads by `normalizeIdentifier(graphId)`.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const graphId = `ut-${secret}`;
		const log = new AuditLog({ path, redact });
		await log.open();
		await log.append({ ...allowed, graph_id: graphId });
		await log.append({ ...claim, graph_id: graphId });
		await log.append({ ...allowed, graph_id: "ut-other" });

		const view = await log.verifiedView(graphId);
		expect(view.records).toHaveLength(2);
		expect(view.stats.total).toBe(2);
		// And it says the selection is not the identifier that was asked for.
		expect(view.selector).toBe("ut-[REDACTED]");
		expect(view.records.every((record) => record.graph_id === "ut-[REDACTED]")).toBe(true);
	});

	test("an ordinary graph id selects itself, unchanged", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, redact });
		await log.open();
		await log.append({ ...allowed, graph_id: "ut-mfk2p3-9a3b1c7d" });

		const view = await log.verifiedView("ut-mfk2p3-9a3b1c7d");
		expect(view.selector).toBe("ut-mfk2p3-9a3b1c7d");
		expect(view.records).toHaveLength(1);
	});
});

describe("the evidence window keeps the newest records and counts them all", () => {
	test("a later denial is listed, not dropped for an older allowed record", async () => {
		// The window used to keep the first N, so a claim withdrawal or a batch correction —
		// which by construction comes *after* the record it corrects — was the first thing
		// to fall out of a busy graph's bundle.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append({ ...allowed, graph_id: "ut-1" });
		await log.append({ ...claim, decision: "denied", mode: "fail-open", graph_id: "ut-1", reason: "withdrawn" });

		const view = await log.verifiedView("ut-1", 2);
		expect(view.records).toHaveLength(2);
		expect(view.records.map((record) => record.seq)).toEqual([5, 6]);
		expect(view.records.at(-1)?.decision).toBe("denied");
	});

	test("the tally covers every record for the graph, not just the listed window", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 4; i++) await log.append({ ...allowed, graph_id: "ut-1" });
		for (let i = 0; i < 3; i++) {
			await log.append({ ...claim, decision: "denied", mode: "fail-open", graph_id: "ut-1", reason: "no" });
		}
		await log.append({ ...allowed, graph_id: "ut-other" });

		const view = await log.verifiedView("ut-1", 2);
		expect(view.records).toHaveLength(2);
		expect(view.matched).toBe(7);
		// A wrong number is worse than a partial list: these count all seven.
		expect(view.stats.total).toBe(7);
		expect(view.stats.allowed).toBe(4);
		expect(view.stats.denied).toBe(3);
		expect(view.stats.byTool.find((entry) => entry.tool === "graph_claim")?.denied).toBe(3);
	});

	test("with no limit the window is the whole selection", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 3; i++) await log.append({ ...allowed, graph_id: "ut-1" });

		const view = await log.verifiedView("ut-1");
		expect(view.records).toHaveLength(3);
		expect(view.matched).toBe(3);
		expect(view.stats.total).toBe(3);
	});
});

describe("the evidence window is a ring, not a shifting array", () => {
	test("keeps the newest records in order across a wrap", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 10; i++) await log.append({ ...allowed, graph_id: "ut-1" });

		const view = await log.verifiedView("ut-1", 3);
		// Oldest first within the window, and the window is the last three.
		expect(view.records.map((record) => record.seq)).toEqual([8, 9, 10]);
		expect(view.matched).toBe(10);
	});

	test("and before a wrap, when there are fewer matches than the cap", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 2; i++) await log.append({ ...allowed, graph_id: "ut-1" });

		expect((await log.verifiedView("ut-1", 5)).records.map((record) => record.seq)).toEqual([1, 2]);
	});

	test("exactly at the cap", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < 4; i++) await log.append({ ...allowed, graph_id: "ut-1" });

		expect((await log.verifiedView("ut-1", 4)).records.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
	});

	test("a full window is kept by overwriting in place, so the scan never shifts or splices", async () => {
		// The deterministic form of the guard below. The quadratic cost came from dropping
		// the first entry of a full window with `shift`/`splice` once per matching record.
		// Nothing else on the scan path uses either (the probe that justified this test
		// counted zero calls at 1000, 4000 and 8000 records), so a single call here is that
		// regression, on any host, with no clock involved.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const when = new Date("2026-10-09T00:00:00.000Z");
		const lines: string[] = [];
		let prev: string | null = null;
		for (let seq = 1; seq <= 600; seq++) {
			const record = buildRecord({ ...allowed, graph_id: "ut-1" }, { seq, prev }, when);
			lines.push(JSON.stringify(record));
			prev = record.hash;
		}
		writeFileSync(path, `${lines.join("\n")}\n`);
		const log = new AuditLog({ path, checkpointPath: false });
		await log.open();

		const { shift, splice } = Array.prototype;
		let shifts = 0;
		let splices = 0;
		Array.prototype.shift = function (this: unknown[]) {
			shifts++;
			return shift.call(this);
		} as typeof Array.prototype.shift;
		Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
			splices++;
			return (splice as (...rest: unknown[]) => unknown[]).apply(this, args);
		} as typeof Array.prototype.splice;
		let view: Awaited<ReturnType<AuditLog["verifiedView"]>>;
		try {
			view = await log.verifiedView("ut-1", 50);
		} finally {
			Array.prototype.shift = shift;
			Array.prototype.splice = splice;
		}

		expect(view.matched).toBe(600);
		expect(view.records.map((record) => record.seq)).toEqual(Array.from({ length: 50 }, (_unused, index) => 551 + index));
		expect({ shifts, splices }).toEqual({ shifts: 0, splices: 0 });
	});

	test("the scan does not go quadratic once the window is full", async () => {
		// Push-and-splice shifted the whole window per matching record, so a graph past the
		// cap paid O(n·window) on the request this single-pass rework exists to make cheap.
		// Measured rather than asserted: doubling the records past a small cap must not
		// anywhere near quadruple the work.
		//
		// Two things keep that measurement about the scan and not about the host:
		//   - The chain file is seeded in one write. Appending 8000 records one durable
		//     write at a time (plus a checkpoint rewrite each) cost tens of seconds on a
		//     loaded machine and timed the disk, not the scan. `open` still adopts and the
		//     scan still verifies the whole chain, so what is measured is unchanged.
		//   - Each size is the best of three passes, so one slow pass on a shared runner
		//     cannot decide the result either way.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const seed = (count: number): void => {
			const when = new Date("2026-10-09T00:00:00.000Z");
			const lines: string[] = [];
			let prev: string | null = null;
			for (let seq = 1; seq <= count; seq++) {
				const record = buildRecord({ ...allowed, graph_id: "ut-1" }, { seq, prev }, when);
				lines.push(JSON.stringify(record));
				prev = record.hash;
			}
			writeFileSync(path, `${lines.join("\n")}\n`);
		};
		const bestOfThree = async (count: number): Promise<{ best: number; matched: number; seqs: number[] }> => {
			seed(count);
			const log = new AuditLog({ path, checkpointPath: false });
			await log.open();
			let best = Number.POSITIVE_INFINITY;
			let view = await log.verifiedView("ut-1", 50);
			for (let pass = 0; pass < 3; pass++) {
				const started = performance.now();
				view = await log.verifiedView("ut-1", 50);
				best = Math.min(best, performance.now() - started);
			}
			return { best, matched: view.matched, seqs: view.records.map((record) => record.seq) };
		};

		const half = await bestOfThree(4000);
		const full = await bestOfThree(8000);

		expect(half.matched).toBe(4000);
		expect(full.matched).toBe(8000);
		expect(full.seqs).toEqual(Array.from({ length: 50 }, (_unused, index) => 7951 + index));
		// Linear would be ~2x. Allow generous slack for a shared runner; quadratic in the
		// window would have been far worse than this before the ring.
		expect(full.best).toBeLessThan(Math.max(half.best * 6, 250));
	}, 60_000);
});

describe("a tally's breakdown is bounded", () => {
	test("an invented tool name cannot grow it without limit", async () => {
		// `tool` comes from a JSON-RPC `params.name` and is audited before the dispatcher
		// validates it, so the set of distinct names is the caller's to choose. Once the tally
		// covered every record rather than the listed window, that set became what
		// `/evidence` builds and serialises.
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (let i = 0; i < MAX_TALLY_KEYS + 50; i++) {
			await log.append({ ...allowed, tool: `invented_${i}`, graph_id: "ut-1" });
		}

		const view = await log.verifiedView("ut-1", 10);
		// The cap, plus the overflow bucket that is admitted beyond it so the breakdown still
		// sums to the total — the same trade `MetricRegistry` makes for its collapsed series.
		expect(view.stats.byTool.length).toBe(MAX_TALLY_KEYS + 1);
		// The totals stay exact; only the breakdown collapses.
		expect(view.stats.total).toBe(MAX_TALLY_KEYS + 50);
		expect(view.stats.allowed).toBe(MAX_TALLY_KEYS + 50);
		const overflow = view.stats.byTool.find((entry) => entry.tool === TALLY_OVERFLOW);
		expect(overflow?.allowed).toBe(50);
		// And the sum of the breakdown still equals the total, so a reader can trust it.
		expect(view.stats.byTool.reduce((sum, entry) => sum + entry.allowed, 0)).toBe(MAX_TALLY_KEYS + 50);
	});

	test("an ordinary deployment never reaches the cap", async () => {
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path });
		await log.open();
		for (const tool of ["graph_get", "graph_claim", "memory_write", "events_emit"]) {
			await log.append({ ...allowed, tool, graph_id: "ut-1" });
		}

		const view = await log.verifiedView("ut-1");
		expect(view.stats.byTool.map((entry) => entry.tool)).toEqual([
			"events_emit",
			"graph_claim",
			"graph_get",
			"memory_write",
		]);
		expect(view.stats.byTool.some((entry) => entry.tool === TALLY_OVERFLOW)).toBe(false);
	});
});

describe("rollover by size", () => {
	/**
	 * A fixed clock, one input and single-digit seq make every record past the first
	 * the same size; the first is 62 bytes shorter, its `prev` being `null` rather than
	 * a digest. `size` is that steady-state record; `head` the first.
	 */
	const clock = () => new Date("2026-10-13T12:00:00.000Z");

	async function recordBytes(input: AuditRecordInput = allowed): Promise<{ head: number; size: number }> {
		const path = join(temporaryDirectory(), "probe.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: null });
		await log.open();
		await log.append(input);
		const head = statSync(path).size;
		await log.append(input);
		return { head, size: statSync(path).size - head };
	}

	test("closes a segment named by its seq range, at 0600, exactly when the next record would not fit", async () => {
		const { head, size } = await recordBytes();
		const dir = temporaryDirectory();
		const path = join(dir, "mcp-audit.jsonl");
		// Two steady-state records fit exactly; the third would take the file past the
		// limit, so it opens the next file. Records 3 and 4 then fill the second file to
		// the byte, which is the boundary: equal is in, one byte more is the next segment.
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) expect((await log.append(allowed)).written).toBe(true);

		expect(readdirSync(dir).sort()).toEqual([
			"mcp-audit.jsonl",
			"mcp-audit.jsonl.1-2.jsonl",
			"mcp-audit.jsonl.3-4.jsonl",
			"mcp-audit.jsonl.checkpoint",
		]);
		for (const name of ["mcp-audit.jsonl", "mcp-audit.jsonl.1-2.jsonl", "mcp-audit.jsonl.3-4.jsonl"]) {
			expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
		}
		// Each file holds whole lines only: a roll happens between records, never through one.
		expect(readFileSync(segmentPath(path, 1, 2), "utf8").trim().split("\n").map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
		expect(readFileSync(segmentPath(path, 3, 4), "utf8").trim().split("\n").map((line) => JSON.parse(line).seq)).toEqual([3, 4]);
		expect(readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).seq)).toEqual([5]);
		expect(statSync(segmentPath(path, 1, 2)).size).toBe(head + size);
		expect(statSync(segmentPath(path, 3, 4)).size).toBe(size * 2);
	});

	test("the new active file's first record chains prev to the closed segment's tip", async () => {
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 3; i++) await log.append(allowed);

		const closed = readFileSync(segmentPath(path, 1, 2), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const active = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(active).toHaveLength(1);
		expect(active[0].seq).toBe(3);
		expect(active[0].prev).toBe(closed[1].hash);
		// The checkpoint carried forward: it names the tip wherever the tip's file is.
		expect(JSON.parse(readFileSync(`${path}.checkpoint`, "utf8"))).toMatchObject({ seq: 3, hash: active[0].hash });
	});

	test("verify, stats and the evidence view walk every segment before the active file", async () => {
		const tagged: AuditRecordInput = { ...allowed, graph_id: "ut-1" };
		const { size } = await recordBytes(tagged);
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(tagged);

		expect(await log.verify()).toMatchObject({ ok: true, records: 5, unparseable: 0 });
		const all = await log.readAll();
		expect(all.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
		const view = await log.verifiedView("ut-1");
		expect(view.verdict.ok).toBe(true);
		expect(view.matched).toBe(5);
		expect(view.stats.allowed).toBe(5);
		expect(await log.report()).toEqual({ segments: 2, records: 5, firstSeq: 1, lastSeq: 5, ok: true, unparseable: 0 });

		// A verifier that never opens the log for writing reads the same chain.
		const reader = new AuditLog({ path });
		expect(await reader.report()).toEqual({ segments: 2, records: 5, firstSeq: 1, lastSeq: 5, ok: true, unparseable: 0 });
		expect(statSync(path).size).toBe(size);
	});

	test("a corrupted closed segment fails the verdict rather than being skipped", async () => {
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(allowed);

		// Edit a record inside the first segment in place.
		const segment = segmentPath(path, 1, 2);
		const lines = readFileSync(segment, "utf8").trim().split("\n");
		const tampered = { ...JSON.parse(lines[1] as string), decision: "denied" };
		writeFileSync(segment, `${lines[0]}\n${JSON.stringify(tampered)}\n`);
		expect(await log.verify()).toMatchObject({ ok: false, brokenAt: 2, reason: "hash does not match contents" });

		// A segment that is gone is a chain that no longer opens at seq 1.
		rmSync(segment);
		const verdict = await log.verify();
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toContain("does not open at seq 1");

		// A reader with only the checkpoint to go on reports the same loss as missing history.
		rmSync(segmentPath(path, 3, 4));
		rmSync(path);
		const reader = new AuditLog({ path });
		const report = await reader.report();
		expect(report).toMatchObject({ ok: false, segments: 0, records: 0, firstSeq: null, lastSeq: null });
		expect(report.reason).toContain("missing history");
	});

	test("a chain continues across a restart, including one that died between a roll and the next record", async () => {
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await first.open();
		for (let i = 0; i < 3; i++) await first.append(allowed);
		const tip = first.tip;

		// The ordinary restart: the active file holds seq 3 and names the next segment from it.
		const second = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		expect(await second.open()).toMatchObject({ records: 3, tip, durable: true });
		await second.append(allowed);
		await second.append(allowed);
		expect(readdirSync(join(path, "..")).sort()).toContain("mcp-audit.jsonl.3-4.jsonl");
		expect(await second.verify()).toMatchObject({ ok: true, records: 5 });

		// The crash between renaming the active file and writing the next record: the
		// path is gone, a segment ends the chain, and the checkpoint agrees with it.
		renameSync(path, segmentPath(path, 5, 5));
		const third = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		const opened = await third.open();
		expect(opened).toMatchObject({ records: 5, tip: second.tip, durable: true });
		expect(opened.missingHistory).toBeUndefined();
		const sixth = await third.append(allowed);
		expect(sixth.record.seq).toBe(6);
		expect(sixth.record.prev).toBe(second.tip);
		expect(await third.report()).toMatchObject({ segments: 3, records: 6, firstSeq: 1, lastSeq: 6, ok: true });
	});

	test("a write cut in half right after a roll recovers from the closed segment, not as missing history", async () => {
		// Greptile round 2: the process died partway through the *first* append after
		// a roll. The active file then holds bytes but no complete record, and the old
		// fallback only consulted the closed segment for an empty file — so every
		// checkpointed record was reported missing when all of them sat in that
		// segment. The segment is the tip; the fragment stays, terminated and counted.
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const first = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await first.open();
		for (let i = 0; i < 3; i++) await first.append(allowed);
		const tip = first.tip;
		renameSync(path, segmentPath(path, 3, 3));
		const fragment = '{"seq":4,"ts":"2026-01-01T00:00:00.000Z","partial';
		writeFileSync(path, fragment);

		const second = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		const opened = await second.open();
		expect(opened).toMatchObject({ records: 3, tip, durable: true });
		expect(opened.missingHistory).toBeUndefined();
		expect(opened.error).toBeUndefined();
		// The fragment is still there, terminated so the next record cannot be swallowed by it.
		expect(readFileSync(path, "utf8")).toBe(`${fragment}\n`);

		const fourth = await second.append(allowed);
		expect(fourth.written).toBe(true);
		expect(fourth.record.seq).toBe(4);
		expect(fourth.record.prev).toBe(tip);
		// Four records across three files, one line that is not a record, and the verdict
		// names the fragment — not missing history — as the reason it cannot say ok.
		const report = await second.report();
		expect(report).toMatchObject({ segments: 2, records: 4, firstSeq: 1, lastSeq: 4, ok: false, unparseable: 1 });
		expect(report.reason).toContain("could not be parsed");
		expect(report.reason).not.toContain("missing history");
		expect(await new AuditLog({ path }).report()).toMatchObject({ segments: 2, records: 4, lastSeq: 4, unparseable: 1 });
		// The next roll names the file by the record that follows the segment, not the fragment.
		await second.append(allowed);
		expect(readdirSync(join(path, "..")).sort()).toContain("mcp-audit.jsonl.4-4.jsonl");
	});

	test("a fragment-only active file is never rolled under a reversed range the verifier would skip", async () => {
		// Greptile round 3: after the recovery above, `activeFirstSeq` is the seq the
		// next record will have, one past `chainSeq`. If the fragment plus that record
		// exceeded the limit, the roll renamed the fragment to `4-3` — a name
		// `parseSegmentName` rejects, so the verifier never read it and the damaged
		// write verified clean. The record goes into the file instead; the roll waits
		// for the record after it, and the fragment closes inside `4-4` where it is read.
		const { size } = await recordBytes();
		const dir = temporaryDirectory();
		const path = join(dir, "mcp-audit.jsonl");
		const first = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await first.open();
		for (let i = 0; i < 3; i++) await first.append(allowed);
		const tip = first.tip;
		renameSync(path, segmentPath(path, 3, 3));
		// Longer than one record, so fragment + the next record is over the limit.
		const fragment = `{"seq":4,"partial":"${"x".repeat(size)}`;
		writeFileSync(path, fragment);

		const second = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		expect(await second.open()).toMatchObject({ records: 3, tip, durable: true });
		const fourth = await second.append(allowed);
		expect(fourth).toMatchObject({ written: true, record: { seq: 4, prev: tip } });

		const wellFormed = (names: string[]): void => {
			for (const name of names) {
				if (name === "mcp-audit.jsonl" || name === "mcp-audit.jsonl.checkpoint") continue;
				const match = /^mcp-audit\.jsonl\.(\d+)-(\d+)\.jsonl$/.exec(name);
				expect(match).not.toBeNull();
				expect(Number(match?.[1])).toBeLessThanOrEqual(Number(match?.[2]));
			}
		};
		// No roll: the file held nothing committed. The record landed after the fragment.
		wellFormed(readdirSync(dir));
		expect(readdirSync(dir).sort()).toEqual(["mcp-audit.jsonl", "mcp-audit.jsonl.1-2.jsonl", "mcp-audit.jsonl.3-3.jsonl", "mcp-audit.jsonl.checkpoint"]);
		expect(readFileSync(path, "utf8")).toBe(`${fragment}\n${JSON.stringify(fourth.record)}\n`);
		const report = await second.report();
		expect(report).toMatchObject({ segments: 2, records: 4, firstSeq: 1, lastSeq: 4, ok: false, unparseable: 1 });
		expect(report.reason).toContain("could not be parsed");

		// The record after it rolls: the file now holds seq 4, so it closes as `4-4`
		// (equal is in, one byte more is the next segment) with the fragment inside.
		const fifth = await second.append(allowed);
		expect(fifth.record.seq).toBe(5);
		wellFormed(readdirSync(dir));
		expect(readdirSync(dir)).toContain("mcp-audit.jsonl.4-4.jsonl");
		expect(readFileSync(segmentPath(path, 4, 4), "utf8")).toBe(`${fragment}\n${JSON.stringify(fourth.record)}\n`);
		expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(fifth.record)}\n`);
		expect(await second.report()).toMatchObject({ segments: 3, records: 5, firstSeq: 1, lastSeq: 5, ok: false, unparseable: 1 });
		expect(await new AuditLog({ path }).report()).toMatchObject({ segments: 3, records: 5, lastSeq: 5, ok: false, unparseable: 1 });
	});

	test("off by default, and off for anything that is not a positive integer", async () => {
		const { size } = await recordBytes();
		const dir = temporaryDirectory();
		const path = join(dir, "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: null });
		await log.open();
		const written: number[] = [];
		for (let i = 0; i < 10; i++) written.push((await log.append(allowed)).record.seq);
		expect(readdirSync(dir).sort()).toEqual(["mcp-audit.jsonl", "mcp-audit.jsonl.checkpoint"]);
		// Ten records in the one file and nothing else: the file is exactly their encoded
		// lines. (Record 10 is a byte longer than its predecessors — two seq digits — so
		// the steady-state size is not a multiplier here, only a lower bound.)
		const { records } = await log.readAll();
		expect(records.map((record) => record.seq)).toEqual(written);
		expect(statSync(path).size).toBe(records.reduce((total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`), 0));
		expect(statSync(path).size).toBeGreaterThan(size * 9);
		expect(log.rolloverLimit).toBeNull();

		expect(rolloverBytesFromEnv({})).toBeNull();
		expect(rolloverBytesFromEnv({ SUBSTRATE_AUDIT_ROLLOVER_BYTES: "" })).toBeNull();
		expect(rolloverBytesFromEnv({ SUBSTRATE_AUDIT_ROLLOVER_BYTES: "0" })).toBeNull();
		expect(rolloverBytesFromEnv({ SUBSTRATE_AUDIT_ROLLOVER_BYTES: "50MB" })).toBeNull();
		expect(rolloverBytesFromEnv({ SUBSTRATE_AUDIT_ROLLOVER_BYTES: "-1" })).toBeNull();
		expect(rolloverBytesFromEnv({ SUBSTRATE_AUDIT_ROLLOVER_BYTES: " 52428800 " })).toBe(52_428_800);
		expect(new AuditLog({ path: null, rolloverBytes: 0 }).rolloverLimit).toBeNull();
		expect(new AuditLog({ path: null, rolloverBytes: 1.5 }).rolloverLimit).toBeNull();
		expect(new AuditLog({ path: null, rolloverBytes: 4096 }).rolloverLimit).toBe(4096);
	});

	test("segment names are strict and ordered by sequence", () => {
		const path = "/var/lib/substrate/mcp-audit.jsonl";
		expect(parseSegmentName(path, "mcp-audit.jsonl.1-9000.jsonl")).toEqual({
			path: "/var/lib/substrate/mcp-audit.jsonl.1-9000.jsonl",
			firstSeq: 1,
			lastSeq: 9000,
		});
		expect(parseSegmentName(path, "mcp-audit.jsonl")).toBeNull();
		expect(parseSegmentName(path, "mcp-audit.jsonl.checkpoint")).toBeNull();
		expect(parseSegmentName(path, "mcp-audit.jsonl.checkpoint.tmp")).toBeNull();
		expect(parseSegmentName(path, "mcp-audit.jsonl.9-1.jsonl")).toBeNull();
		expect(parseSegmentName(path, "mcp-audit.jsonl.0-1.jsonl")).toBeNull();
		expect(parseSegmentName(path, "other.jsonl.1-2.jsonl")).toBeNull();
		expect(parseSegmentName(path, "mcp-audit.jsonl.1-2.jsonl.bak")).toBeNull();
		expect(segmentPath(path, 9001, 18000)).toBe("/var/lib/substrate/mcp-audit.jsonl.9001-18000.jsonl");
		expect(
			orderSegments([
				{ path: "c", firstSeq: 9001, lastSeq: 18000 },
				{ path: "a", firstSeq: 1, lastSeq: 9000 },
				{ path: "b", firstSeq: 18001, lastSeq: 18001 },
			]).map((segment) => segment.path),
		).toEqual(["a", "c", "b"]);
	});

	test("a rollover between listing the segments and reading the active file is read again, not reported", async () => {
		// The race: a reader lists the closed segments (none yet), then the writer
		// rolls the file over, then the reader opens the active file — which now holds
		// only the records after the roll. Without a second look the reader sees a
		// chain that opens past seq 1. `begin` runs exactly in that window.
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const writer = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await writer.open();
		await writer.append(allowed);
		await writer.append(allowed);
		expect(listAuditSegments(path)).toEqual([]);

		let passes = 0;
		let walker = new ChainWalker();
		const seen: number[][] = [];
		const walked = await walkAuditFiles(path, () => {
			passes++;
			walker = new ChainWalker();
			seen.push([]);
			if (passes === 1) {
				// The writer rolls while the reader is between the listing and the read.
				void writer.append(allowed);
			}
			return { walker, onRecord: (record) => seen[seen.length - 1]?.push(record.seq) };
		});
		expect(listAuditSegments(path).map((segment) => [segment.firstSeq, segment.lastSeq])).toEqual([[1, 2]]);
		expect(walked.attempts).toBe(2);
		expect(seen[0]).toEqual([3]);
		expect(seen[1]).toEqual([1, 2, 3]);
		expect(walker.verdict()).toEqual({ ok: true, records: 3 });
		expect(walked).toMatchObject({ segments: 1, firstSeq: 1, lastSeq: 3, unparseable: 0 });

		// The same chain through the public paths, after the dust has settled.
		expect(await writer.verify()).toMatchObject({ ok: true, records: 3 });
		expect(await verifyAuditSegments(path)).toMatchObject({ ok: true, segments: 1, records: 3 });
	});

	test("a chain genuinely broken at a segment boundary is reported after a bounded number of attempts", async () => {
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(allowed);
		// Drop the active file's first record: it now begins at 6 while the newest
		// closed segment ends at 4, which is what a mid-walk roll also looks like —
		// except that re-reading finds the same files every time.
		await log.append(allowed);
		const lines = readFileSync(path, "utf8").trim().split("\n");
		writeFileSync(path, `${lines[1]}\n`);

		let passes = 0;
		let walker = new ChainWalker();
		const walked = await walkAuditFiles(path, () => {
			passes++;
			walker = new ChainWalker();
			return { walker, onRecord: () => {} };
		});
		expect(passes).toBe(MAX_WALK_ATTEMPTS);
		expect(walked.attempts).toBe(MAX_WALK_ATTEMPTS);
		expect(walker.verdict()).toMatchObject({ ok: false, brokenAt: 6, reason: "prev does not match the preceding record" });
		expect(await log.verify()).toMatchObject({ ok: false, brokenAt: 6 });
		expect(await verifyAuditSegments(path)).toMatchObject({ ok: false, brokenAt: 6, segments: 2, records: 5 });
	});

	test("a steady chain is read in one pass", async () => {
		const { size } = await recordBytes();
		const path = join(temporaryDirectory(), "mcp-audit.jsonl");
		const log = new AuditLog({ path, now: clock, rolloverBytes: size * 2 });
		await log.open();
		for (let i = 0; i < 5; i++) await log.append(allowed);
		const walked = await walkAuditFiles(path, () => ({ walker: new ChainWalker(), onRecord: () => {} }));
		expect(walked).toEqual({ unparseable: 0, segments: 2, firstSeq: 1, lastSeq: 5, attempts: 1 });
	});
});
