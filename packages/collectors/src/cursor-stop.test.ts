import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../../mcp-server/src/types.ts";
import {
	copyTranscript,
	parseStopInput,
	runStop,
	safeConversationId,
	transcriptSource,
} from "./cursor-stop.ts";

// A GitHub token shape the event redactor removes.
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const ID = "abc-12345678";

let tmp: string;
let root: string;
let outside: string;
let dest: string;

beforeEach(() => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "cursor-stop-")));
	root = join(tmp, "cursor");
	outside = join(tmp, "outside");
	dest = join(tmp, "dest", "cursor");
	mkdirSync(join(root, "projects", "p", "agent-transcripts", ID), { recursive: true });
	mkdirSync(outside, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function transcript(text = `{"role":"user","text":"use ${TOKEN} please"}\n`): string {
	const path = join(root, "projects", "p", "agent-transcripts", ID, `${ID}.jsonl`);
	writeFileSync(path, text);
	return path;
}

function recorder(): { events: EventInput[]; emit: (event: EventInput) => Promise<void> } {
	const events: EventInput[] = [];
	return { events, emit: async (event) => void events.push(event) };
}

describe("parseStopInput", () => {
	test("strips a BOM and returns the envelope", () => {
		const input = parseStopInput(`\ufeff{"conversation_id":"${ID}","transcript_path":null,"status":"completed"}`);
		expect(input).toEqual({ conversation_id: ID, transcript_path: null, status: "completed" });
	});

	test("returns null for anything that is not a JSON object", () => {
		expect(parseStopInput("not json")).toBeNull();
		expect(parseStopInput("[1,2]")).toBeNull();
		expect(parseStopInput("null")).toBeNull();
		expect(parseStopInput("")).toBeNull();
	});
});

describe("safeConversationId", () => {
	test("accepts a plain id and rejects traversal, short, long and dotted ids", () => {
		expect(safeConversationId(ID)).toBe(true);
		for (const bad of ["../x", "a", "a".repeat(200), "abcd/12345678", "abcd.12345678", 12345678, null]) {
			expect(safeConversationId(bad)).toBe(false);
		}
	});
});

describe("transcriptSource", () => {
	test("returns the realpath of a regular file under root", () => {
		const path = transcript();
		expect(transcriptSource(path, root)).toBe(path);
	});

	test("refuses a file outside root, a directory and a missing file", () => {
		const foreign = join(outside, "x.jsonl");
		writeFileSync(foreign, "{}\n");
		expect(transcriptSource(foreign, root)).toBeNull();
		expect(transcriptSource(join(root, "projects"), root)).toBeNull();
		expect(transcriptSource(join(root, "missing.jsonl"), root)).toBeNull();
		// A sibling whose name only shares root as a prefix is outside it too.
		mkdirSync(`${root}-evil`);
		writeFileSync(`${root}-evil/x.jsonl`, "{}\n");
		expect(transcriptSource(`${root}-evil/x.jsonl`, root)).toBeNull();
	});

	test("refuses a symlink under root that points outside it", () => {
		const foreign = join(outside, "secret.jsonl");
		writeFileSync(foreign, "{}\n");
		const link = join(root, "link.jsonl");
		symlinkSync(foreign, link);
		expect(transcriptSource(link, root)).toBeNull();
	});
});

describe("copyTranscript", () => {
	test("writes a redacted 0600 copy into a 0700 dir through a tmp name", () => {
		const result = copyTranscript(transcript(), ID, dest);
		const out = join(dest, `${ID}.jsonl`);
		expect(result).toEqual({ ref: out });
		const text = readFileSync(out, "utf8");
		expect(text).not.toContain(TOKEN);
		expect(text).toContain("[REDACTED]");
		expect(statSync(out).mode & 0o777).toBe(0o600);
		expect(statSync(dest).mode & 0o777).toBe(0o700);
		// Only the final file remains: the tmp name was renamed, not left behind.
		expect(readdirSync(dest)).toEqual([`${ID}.jsonl`]);
	});

	test("refuses a source over the size cap", () => {
		const result = copyTranscript(transcript("x".repeat(64)), ID, dest, 32);
		expect(result).toEqual({ ref: null, reason: "too large" });
		expect(existsSync(join(dest, `${ID}.jsonl`))).toBe(false);
	});
});

describe("runStop", () => {
	test("copies an in-root transcript and emits session.end naming it", async () => {
		const { events, emit } = recorder();
		const raw = JSON.stringify({ conversation_id: ID, transcript_path: transcript(), status: "completed" });
		await runStop(raw, { emit, root, destDir: dest });
		expect(events).toEqual([
			{
				surface: "cursor",
				kind: "session.end",
				actor: "human",
				session_id: ID,
				summary: "cursor session ended",
				payload: { conversation_id: ID, transcript_ref: join(dest, `${ID}.jsonl`), status: "completed" },
			},
		]);
	});

	test("a null transcript_path emits a null ref with a reason", async () => {
		const { events, emit } = recorder();
		const raw = JSON.stringify({ conversation_id: ID, transcript_path: null, status: "aborted" });
		await runStop(raw, { emit, root, destDir: dest });
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toEqual({
			conversation_id: ID,
			transcript_ref: null,
			status: "aborted",
			reason: "no transcript_path",
		});
		expect(existsSync(dest)).toBe(false);
	});

	test("an out-of-root path emits a null ref and writes nothing", async () => {
		const { events, emit } = recorder();
		const foreign = join(outside, "x.jsonl");
		writeFileSync(foreign, "{}\n");
		const raw = JSON.stringify({ conversation_id: ID, transcript_path: foreign, status: "completed" });
		await runStop(raw, { emit, root, destDir: dest });
		expect(events[0]?.payload?.transcript_ref).toBeNull();
		expect(events[0]?.payload?.reason).toBe(`transcript outside ${root}`);
		expect(existsSync(dest)).toBe(false);
	});

	test("an invalid id or malformed envelope still emits, without a session id or copy", async () => {
		const { events, emit } = recorder();
		await runStop(JSON.stringify({ conversation_id: "../x", transcript_path: transcript() }), { emit, root, destDir: dest });
		await runStop("not json", { emit, root, destDir: dest });
		expect(events.map((e) => [e.session_id, e.payload?.reason])).toEqual([
			[undefined, "invalid conversation_id"],
			[undefined, "malformed envelope"],
		]);
		expect(existsSync(dest)).toBe(false);
	});

	test("a rejecting emit is swallowed and nothing is written to stdout", async () => {
		const writes: unknown[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			writes.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			const raw = JSON.stringify({ conversation_id: ID, transcript_path: transcript(), status: "error" });
			const result = await runStop(raw, {
				emit: () => Promise.reject(new Error("substrate unreachable")),
				root,
				destDir: dest,
			});
			expect(result.ref).toBe(join(dest, `${ID}.jsonl`));
		} finally {
			process.stdout.write = original;
		}
		expect(writes).toEqual([]);
	});
});
