import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ROLLBACK_TRANSCRIPT_OUTCOMES, type TranscriptRef } from "../../../mcp-server/src/session-events.ts";
import { OMP_TITLE_SLOT_BYTES, ompTranscriptRef, parseOmpSession } from "./omp-fork.ts";
import type { TranscriptRewindRequest } from "./rollback.ts";
import {
	MAX_LISTED_FILES,
	createTranscriptPort,
	matchOmpSessionFiles,
	ompBucketName,
	ompResumeCommand,
	resolveOmpSessionsDir,
	type TranscriptPortFs,
} from "./transcript-port.ts";

// Every fixture is synthetic: ids, prompts and paths are invented for these tests.

const DIR = "/synthetic/omp/sessions/-work-project";
const ORIGINAL_ID = "01900000-0000-7000-8000-00000000aaaa";
const ORIGINAL_NAME = `2026-10-20T08-00-00-000Z_${ORIGINAL_ID}.jsonl`;
const NEW_ID = "01900000-0000-7000-8000-00000000bbbb";
const FIXED = new Date("2026-10-26T12:00:00.000Z");
const FORK_NAME = `2026-10-26T12-00-00-000Z_${NEW_ID}.jsonl`;

type Obj = Record<string, unknown>;

function slotLine(title: string): string {
	const base = { type: "title", v: 1, title, source: "auto", updatedAt: "2026-10-20T08:00:00.000Z" };
	const bare = JSON.stringify({ ...base, pad: "" });
	return `${JSON.stringify({ ...base, pad: " ".repeat(OMP_TITLE_SLOT_BYTES - Buffer.byteLength(bare) - 1) })}\n`;
}

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): Obj {
	return { type: "message", id, parentId, timestamp: "2026-10-20T08:00:01.000Z", message: { role, content: [{ type: "text", text }] } };
}

function sessionText(entries: Obj[]): string {
	const header = { type: "session", version: 3, id: ORIGINAL_ID, timestamp: "2026-10-20T08:00:00.000Z", cwd: "/synthetic/project" };
	return `${slotLine("synthetic title")}${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const ENTRIES: Obj[] = [
	message("a1a1a1a1", null, "user", "synthetic prompt one"),
	message("a2a2a2a2", "a1a1a1a1", "assistant", "synthetic answer one"),
	message("a3a3a3a3", "a2a2a2a2", "user", "synthetic prompt two"),
	message("a4a4a4a4", "a3a3a3a3", "assistant", "synthetic answer two"),
];

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An in-memory directory that records every call, enforces exclusive create and keeps the modes it was given. */
class MemoryFs implements TranscriptPortFs {
	readonly files = new Map<string, string>();
	readonly modes = new Map<string, number>();
	readonly writes: string[] = [];
	listCalls = 0;
	failRead = false;
	failWrite: string | null = null;
	/** Extra names a listing returns that hold no file. */
	extraNames: string[] = [];

	async listDir(dir: string): Promise<string[]> {
		this.listCalls += 1;
		const prefix = `${dir}/`;
		const names = [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
		return [...names, ...this.extraNames];
	}

	async readFile(path: string): Promise<string> {
		const text = this.files.get(path);
		if (this.failRead || text === undefined) throw Object.assign(new Error("read failed"), { code: "ENOENT" });
		return text;
	}

	async writeFile(path: string, text: string, options: { flag: "wx"; mode: number }): Promise<void> {
		expect(options.flag).toBe("wx");
		if (this.failWrite !== null) throw Object.assign(new Error("write failed"), { code: this.failWrite });
		if (this.files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
		this.files.set(path, text);
		this.modes.set(path, options.mode);
		this.writes.push(path);
	}
}

function setup(entries: Obj[] = ENTRIES): { fs: MemoryFs; original: string; ref: TranscriptRef } {
	const fs = new MemoryFs();
	const original = sessionText(entries);
	fs.files.set(`${DIR}/${ORIGINAL_NAME}`, original);
	const ref = ompTranscriptRef({ sessionFileText: original, sessionLocator: ORIGINAL_NAME, entryId: "a3a3a3a3" });
	return { fs, original, ref };
}

function portFor(fs: MemoryFs, overrides: { surface?: string; ompSessionsDir?: string | undefined } = {}) {
	const options = {
		surface: overrides.surface ?? "omp",
		...("ompSessionsDir" in overrides ? (overrides.ompSessionsDir === undefined ? {} : { ompSessionsDir: overrides.ompSessionsDir }) : { ompSessionsDir: DIR }),
		listDir: (dir: string) => fs.listDir(dir),
		readFile: (path: string) => fs.readFile(path),
		writeFile: (path: string, text: string, o: { flag: "wx"; mode: number }) => fs.writeFile(path, text, o),
		now: () => FIXED,
		newSessionId: () => NEW_ID,
	};
	return createTranscriptPort(options);
}

function request(ref: TranscriptRef | undefined, surface = "omp"): TranscriptRewindRequest {
	return {
		sessionId: "s-1",
		surface,
		rollbackId: "rb_00000000000000000000000000",
		targetCkptId: "ckpt_00000000000000000000000000",
		...(ref === undefined ? {} : { transcriptRef: ref }),
	};
}

describe("omp: fork written once, original untouched", () => {
	test("forks at the ref's entry into a NEW 0600 file next to the original and reports moved-leaf", async () => {
		const { fs, original, ref } = setup();
		const before = sha(original);
		const result = await portFor(fs).rewind(request(ref));

		expect(result.outcome).toBe("moved-leaf");
		expect(fs.writes).toEqual([`${DIR}/${FORK_NAME}`]);
		expect(fs.modes.get(`${DIR}/${FORK_NAME}`)).toBe(0o600);
		// The original is byte-identical.
		expect(sha(fs.files.get(`${DIR}/${ORIGINAL_NAME}`) as string)).toBe(before);
		expect(fs.files.size).toBe(2);
		// The fork holds the root-to-target path only.
		const forked = parseOmpSession(fs.files.get(`${DIR}/${FORK_NAME}`) as string);
		expect(forked.entries.map((entry) => entry.id)).toEqual(["a1a1a1a1", "a2a2a2a2", "a3a3a3a3"]);
		// The detail names the new file and the line to run, and says the resume is unverified.
		expect(result.detail).toContain(FORK_NAME);
		expect(result.detail).toContain(ompResumeCommand(NEW_ID));
		expect(result.detail).toContain("UNVERIFIED");
		expect(ROLLBACK_TRANSCRIPT_OUTCOMES).toContain(result.outcome);
	});

	test("the locator may be the bare session id or the file name without .jsonl", async () => {
		for (const locator of [ORIGINAL_ID, ORIGINAL_NAME.replace(/\.jsonl$/, "")]) {
			const { fs, original } = setup();
			const ref = ompTranscriptRef({ sessionFileText: original, sessionLocator: locator, entryId: "a2a2a2a2" });
			expect((await portFor(fs).rewind(request(ref))).outcome).toBe("moved-leaf");
			expect(fs.writes).toHaveLength(1);
		}
	});

	test("a second rewind forks again under a fresh id and still never overwrites: an existing target is refused", async () => {
		const { fs, original, ref } = setup();
		await portFor(fs).rewind(request(ref));
		const forkPath = `${DIR}/${FORK_NAME}`;
		const firstFork = fs.files.get(forkPath) as string;
		// The same id on the same instant collides: exclusive create refuses, and the first fork is unchanged.
		const again = await portFor(fs).rewind(request(ref));
		expect(again.outcome).toBe("unsupported");
		expect(again.detail).toContain("EEXIST");
		expect(again.detail).toContain("original is untouched");
		expect(fs.files.get(forkPath)).toBe(firstFork);
		expect(sha(fs.files.get(`${DIR}/${ORIGINAL_NAME}`) as string)).toBe(sha(original));
	});

	test("a write failure is unsupported with the code, and nothing but the failed fork is missing", async () => {
		const { fs, original, ref } = setup();
		fs.failWrite = "ENOSPC";
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("ENOSPC");
		expect(fs.files.size).toBe(1);
		expect(fs.files.get(`${DIR}/${ORIGINAL_NAME}`)).toBe(original);
	});
});

describe("omp: stale, not found, unsupported", () => {
	test("a changed transcript (prefix mismatch) is stale and writes no file", async () => {
		const { fs, ref } = setup();
		// The original changed after the checkpoint: an entry on the path was rewritten (as a compaction does).
		const rewritten = sessionText([{ ...(ENTRIES[0] as Obj), message: { role: "user", content: [{ type: "text", text: "rewritten" }] } }, ...ENTRIES.slice(1)]);
		fs.files.set(`${DIR}/${ORIGINAL_NAME}`, rewritten);
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("stale");
		expect(fs.writes).toEqual([]);
		expect(sha(fs.files.get(`${DIR}/${ORIGINAL_NAME}`) as string)).toBe(sha(rewritten));
	});

	test("an entry that is gone from the transcript is stale too", async () => {
		const { fs, ref } = setup();
		fs.files.set(`${DIR}/${ORIGINAL_NAME}`, sessionText(ENTRIES.slice(0, 2)));
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("stale");
		expect(fs.writes).toEqual([]);
	});

	test("an original that is not in the bucket is unsupported and says so", async () => {
		const { fs, ref } = setup();
		fs.files.delete(`${DIR}/${ORIGINAL_NAME}`);
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("not found");
		expect(fs.writes).toEqual([]);
	});

	test("a bare session id that matches two files is refused rather than guessed between", async () => {
		const { fs, ref } = setup();
		fs.files.set(`${DIR}/2026-10-21T08-00-00-000Z_${ORIGINAL_ID}.jsonl`, "x");
		const result = await portFor(fs).rewind(request({ ...ref, session_locator: ORIGINAL_ID }));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("2 omp session files match");
		expect(fs.writes).toEqual([]);
	});

	test("a full file name names exactly one file, even when another file shares its session id", async () => {
		const { fs, ref } = setup();
		fs.files.set(`${DIR}/2026-10-21T08-00-00-000Z_${ORIGINAL_ID}.jsonl`, "x");
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("moved-leaf");
		expect(fs.files.get(`${DIR}/2026-10-21T08-00-00-000Z_${ORIGINAL_ID}.jsonl`)).toBe("x");
	});

	test("the search is by name only, bounded, and reads no other file", async () => {
		const { fs, ref } = setup();
		fs.files.delete(`${DIR}/${ORIGINAL_NAME}`);
		fs.extraNames = Array.from({ length: MAX_LISTED_FILES + 1 }, (_, i) => `x${i}.jsonl`);
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("bounded");
		expect(fs.listCalls).toBe(1);
	});

	test("an unreadable directory or file is unsupported with the code, not a throw", async () => {
		const { fs, ref } = setup();
		fs.failRead = true;
		const result = await portFor(fs).rewind(request(ref));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("ENOENT");
		const dead = portFor(fs, { ompSessionsDir: undefined });
		const noDir = await dead.rewind(request(ref));
		expect(noDir.outcome).toBe("unsupported");
		expect(noDir.detail).toContain("not known");
	});

	test("a ref without an entry id or a prefix digest cannot be forked safely", async () => {
		const { fs, ref } = setup();
		const noEntry: TranscriptRef = { surface: "omp", session_locator: ORIGINAL_NAME, turn_no: 1 };
		expect((await portFor(fs).rewind(request(noEntry))).outcome).toBe("unsupported");
		const { prefix_sha256: _dropped, ...noPrefix } = ref;
		const result = await portFor(fs).rewind(request(noPrefix as TranscriptRef));
		expect(result.outcome).toBe("unsupported");
		expect(result.detail).toContain("prefix digest");
		expect(fs.writes).toEqual([]);
	});

	test("a ref for another surface on an omp rewind is unsupported", async () => {
		const { fs } = setup();
		const foreign: TranscriptRef = { surface: "cursor", session_locator: "conv-0000-0000", turn_no: 2 };
		expect((await portFor(fs).rewind(request(foreign))).outcome).toBe("unsupported");
	});
});

describe("other surfaces and wiring", () => {
	test("every other surface is marker-only and touches nothing", async () => {
		for (const surface of ["claude-code", "cursor", "grok-build"]) {
			const fs = new MemoryFs();
			fs.files.set("/other/file", "keep");
			const ref: TranscriptRef = { surface: surface as TranscriptRef["surface"], session_locator: "conv-0000-0000", turn_no: 3 };
			const result = await portFor(fs, { surface }).rewind(request(ref, surface));
			expect(result.outcome).toBe("marker-only");
			expect(fs.writes).toEqual([]);
			expect(fs.listCalls).toBe(0);
			expect(fs.files.get("/other/file")).toBe("keep");
		}
	});

	test("a missing ref is unsupported on every surface", async () => {
		for (const surface of ["omp", "claude-code"]) {
			const fs = new MemoryFs();
			const result = await portFor(fs, { surface }).rewind(request(undefined, surface));
			expect(result.outcome).toBe("unsupported");
			expect(result.detail).toContain("no transcript pointer");
		}
	});

	test("a rewind for a surface the port was not wired for is unsupported", async () => {
		const { fs, ref } = setup();
		const result = await portFor(fs, { surface: "claude-code" }).rewind(request(ref, "omp"));
		expect(result.outcome).toBe("unsupported");
		expect(fs.writes).toEqual([]);
	});

	test("the port exposes no way to modify an existing file: it only ever asks for exclusive create", async () => {
		const { fs, ref } = setup();
		const flags: string[] = [];
		const port = createTranscriptPort({
			surface: "omp",
			ompSessionsDir: DIR,
			listDir: (dir) => fs.listDir(dir),
			readFile: (path) => fs.readFile(path),
			writeFile: async (path, text, options) => {
				flags.push(options.flag);
				await fs.writeFile(path, text, options);
			},
			now: () => FIXED,
			newSessionId: () => NEW_ID,
		});
		await port.rewind(request(ref));
		expect(flags).toEqual(["wx"]);
	});
});

describe("matchOmpSessionFiles and ompBucketName", () => {
	test("matches the whole name, the name without .jsonl or the id, and ignores other files", () => {
		const names = [ORIGINAL_NAME, "2026-10-21T00-00-00-000Z_other.jsonl", "notes.txt", `${ORIGINAL_NAME}.bak`];
		expect(matchOmpSessionFiles(names, ORIGINAL_NAME)).toEqual([ORIGINAL_NAME]);
		expect(matchOmpSessionFiles(names, ORIGINAL_ID)).toEqual([ORIGINAL_NAME]);
		expect(matchOmpSessionFiles(names, ORIGINAL_NAME.slice(0, -6))).toEqual([ORIGINAL_NAME]);
		expect(matchOmpSessionFiles(names, "orig")).toEqual([]);
	});

	test("encodes the working directory by the documented rules", () => {
		expect(ompBucketName("/home/u/src/repos/app", "/home/u", "/tmp")).toBe("-src-repos-app");
		expect(ompBucketName("/home/u", "/home/u", "/tmp")).toBe("-");
		expect(ompBucketName("/tmp/work/x", "/home/u", "/tmp")).toBe("-tmp-work-x");
		expect(ompBucketName("/opt/app", "/home/u", "/tmp")).toBe("--opt-app--");
	});
});

describe("the file read is bounded and the bucket is found without scanning", () => {
	test("the port asks for the original with the omp fork's size cap", async () => {
		const { fs, ref } = setup();
		const asked: number[] = [];
		const port = createTranscriptPort({
			surface: "omp",
			ompSessionsDir: DIR,
			listDir: (dir) => fs.listDir(dir),
			readFile: (path, maxBytes) => {
				asked.push(maxBytes);
				return fs.readFile(path);
			},
			writeFile: (path, text, options) => fs.writeFile(path, text, options),
			now: () => FIXED,
			newSessionId: () => NEW_ID,
		});
		await port.rewind(request(ref));
		expect(asked).toEqual([32 * 1024 * 1024]);
	});

	test("resolveOmpSessionsDir takes the first candidate whose bucket exists and skips one that cannot be resolved", () => {
		const dirs = new Set(["/root/.omp/agent/sessions/-src-repos-app"]);
		const lookup = {
			candidates: ["/gone/dir", "/root/src/repos/app/sub", "/root/src/repos/app", ""],
			homeDir: "/root",
			tmpRoot: "/tmp",
			sessionsRoot: "/root/.omp/agent/sessions",
			realpath: (path: string) => {
				if (path.startsWith("/gone")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return path;
			},
			isDirectory: (path: string) => dirs.has(path),
		};
		expect(resolveOmpSessionsDir(lookup)).toBe("/root/.omp/agent/sessions/-src-repos-app");
		expect(resolveOmpSessionsDir({ ...lookup, candidates: ["/gone/dir", "/opt/other"] })).toBeUndefined();
	});
});
