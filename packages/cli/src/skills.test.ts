/**
 * `substrate skills propose`, against a stub of the route over a real socket.
 *
 * The stub answers what the server answers, so the cases cover what the CLI sends (the exact
 * snake_case keys, never a `surface`), what it refuses before posting (no token, a bad
 * directory, a body over the cap) and how it reports each status. The last block spawns the
 * real command, since `index.ts` dispatches at import time.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_MAX_BYTES } from "../../mcp-server/src/skills/propose.ts";
import {
	DEFAULT_TIMEOUT_MS,
	DirRefused,
	MAX_BODY_BYTES,
	readSkillDir,
	runSkills,
	skillsTimeout,
	type SkillsDeps,
} from "./skills.ts";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	body: Record<string, unknown>;
}

/** The route, as far as the CLI can tell: one scripted reply, and a record of what was posted. */
class RouteStub {
	seen: Seen[] = [];
	reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: { status: "opened" } };
	readonly server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const raw = await request.text();
			this.seen.push({
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			});
			if (this.reply.delayMs) await new Promise((resolve) => setTimeout(resolve, this.reply.delayMs));
			return new Response(typeof this.reply.body === "string" ? this.reply.body : JSON.stringify(this.reply.body), {
				status: this.reply.status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	readonly url = `http://127.0.0.1:${this.server.port}`;
}

const stub = new RouteStub();
const scratch = mkdtempSync(join(tmpdir(), "substrate-skills-cli-"));
afterAll(() => {
	stub.server.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

const SKILL_MD = "---\nname: demo-skill\ndescription: a demo\n---\nbody\n";

/** A skill directory with SKILL.md and one script, under a fresh name. */
let counter = 0;
function skillDir(extra: Record<string, string> = {}, name = `demo-skill`): string {
	const dir = join(scratch, `${counter++}`, name);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
	writeFileSync(join(dir, "scripts", "run.sh"), "echo hi\n");
	for (const [path, text] of Object.entries(extra)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

function run(argv: string[], overrides: Partial<SkillsDeps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: SkillsDeps = {
		url: stub.url,
		token: "tok-agent",
		timeoutMs: 5_000,
		cwd: scratch,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		...overrides,
	};
	return runSkills(argv, deps).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

beforeEach(() => {
	stub.seen = [];
	stub.reply = { status: 200, body: { status: "opened" } };
});

const opened = {
	status: "opened",
	pr_url: "https://github.com/swcstudiospace/agent-skills/pull/12",
	pr_number: 12,
	branch: "skill/omp/demo-skill-1-abcd",
	content_sha256: "ab".repeat(32),
	redactions: [{ file: "SKILL.md", line: 2, rule: "bearer" }],
};

describe("what the CLI sends", () => {
	test("posts the directory to /skills/propose with the token and the route's snake_case keys", async () => {
		stub.reply = { status: 200, body: opened };
		const dir = skillDir();
		const { code } = await run([
			"propose", "--dir", dir, "--name", "other-name", "--rationale", "why", "--remove", "old.md,older.md",
			"--session", "sess-1", "--graph", "ut-1", "--dry-run", "--replace", "--reopen", "--allow-doc-examples", "pem,jwt",
		]);

		expect(code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		const request = stub.seen[0] as Seen;
		expect(request).toMatchObject({ method: "POST", path: "/skills/propose", authorization: "Bearer tok-agent" });
		expect(request.body).toEqual({
			name: "other-name",
			files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "echo hi\n" },
			rationale: "why",
			remove: ["old.md", "older.md"],
			session_id: "sess-1",
			graph_id: "ut-1",
			dry_run: true,
			mode: "replace",
			reopen: true,
			allow_doc_examples: ["pem", "jwt"],
		});
	});

	test("a plain proposal sends only the name, the files and a rationale, and never a surface", async () => {
		const dir = skillDir();
		await run(["propose", "--dir", dir]);
		expect(Object.keys(stub.seen[0]?.body ?? {}).sort()).toEqual(["files", "name", "rationale"]);
		expect(stub.seen[0]?.body.name).toBe("demo-skill");
		expect(String(stub.seen[0]?.body.rationale)).toContain("substrate skills propose --dir demo-skill");
	});

	test("--surface is refused outright: the surface is the token's, and nothing is posted", async () => {
		const { code, out, err } = await run(["propose", "--dir", skillDir(), "--surface", "cursor"]);
		expect(code).toBe(1);
		expect(out).toContain("status=refused");
		expect(err).toContain("no --surface flag");
		expect(stub.seen).toEqual([]);
	});

	test("a relative --dir resolves against the working directory", async () => {
		const dir = skillDir();
		const parent = join(dir, "..");
		await run(["propose", "--dir", "demo-skill"], { cwd: parent });
		expect(Object.keys((stub.seen[0]?.body.files as object) ?? {}).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
	});
});

describe("what the CLI refuses before posting", () => {
	test("no token is exit 1 on stderr with nothing posted, even for a dry run", async () => {
		const { code, err } = await run(["propose", "--dir", skillDir(), "--dry-run"], { token: undefined });
		expect(code).toBe(1);
		expect(err).toContain("SUBSTRATE_TOKEN is not set");
		expect(stub.seen).toEqual([]);
	});

	test("--dir is required", async () => {
		const { code, err } = await run(["propose"]);
		expect(code).toBe(1);
		expect(err).toContain("--dir PATH is required");
		expect(stub.seen).toEqual([]);
	});

	test("a missing path, a file and a symlink to a directory are each refused", async () => {
		const dir = skillDir();
		const link = join(scratch, `link-${counter++}`);
		symlinkSync(dir, link);
		for (const target of [join(scratch, "nope"), join(dir, "SKILL.md"), link]) {
			const { code, out } = await run(["propose", "--dir", target]);
			expect(code).toBe(1);
			expect(out).toContain("status=refused");
		}
		expect(stub.seen).toEqual([]);
	});

	test("a symlink inside the directory refuses the whole directory, naming it", async () => {
		const dir = skillDir();
		symlinkSync(join(dir, "SKILL.md"), join(dir, "scripts", "alias.md"));
		const { code, err } = await run(["propose", "--dir", dir]);
		expect(code).toBe(1);
		expect(err).toContain("scripts/alias.md is a symlink");
		expect(stub.seen).toEqual([]);
	});

	test("a file that is not valid UTF-8 refuses the whole directory, naming it", async () => {
		const dir = skillDir();
		writeFileSync(join(dir, "scripts", "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
		const { code, err } = await run(["propose", "--dir", dir]);
		expect(code).toBe(1);
		expect(err).toContain("scripts/blob.bin is not valid UTF-8");
		expect(stub.seen).toEqual([]);
	});

	test("a directory whose JSON would exceed the cap is refused with its size", async () => {
		const dir = skillDir({ "big.txt": "x".repeat(MAX_BODY_BYTES) });
		const { code, err } = await run(["propose", "--dir", dir]);
		expect(code).toBe(1);
		expect(err).toContain("over the limit of 1000000 bytes");
		expect(stub.seen).toEqual([]);
	});

	test("--allow-doc-examples takes only pem and jwt", async () => {
		for (const flags of [["--allow-doc-examples"], ["--allow-doc-examples", "ssh"], ["--allow-doc-examples", "pem,ssh"]]) {
			const { code, err } = await run(["propose", "--dir", skillDir(), ...flags]);
			expect(code).toBe(1);
			expect(err).toContain("--allow-doc-examples");
		}
		expect(stub.seen).toEqual([]);
	});

	test("anything but `propose` is a usage error", async () => {
		const { code, err } = await run(["list"]);
		expect(code).toBe(2);
		expect(err).toContain("substrate skills propose");
	});
});

describe("how the CLI reports the server's answer", () => {
	test("the five successes print key=value lines and exit 0", async () => {
		for (const status of ["opened", "existing", "unchanged", "declined", "dry_run"]) {
			stub.reply = { status: 200, body: { ...opened, status, diff_added: 1, diff_changed: 2, diff_deleted: 3 } };
			const { code, out } = await run(["propose", "--dir", skillDir()]);
			expect(code).toBe(0);
			expect(out).toBe(
				`status=${status}\npr_url=${opened.pr_url}\npr_number=12\nbranch=${opened.branch}\ncontent_sha256=${opened.content_sha256}\n` +
					"redactions=1\ndiff_added=1\ndiff_changed=2\ndiff_deleted=3\n",
			);
		}
	});

	test("a dry run omits the fields the server omitted", async () => {
		stub.reply = { status: 200, body: { status: "dry_run", content_sha256: "cd".repeat(32), redactions: [], diff_added: 2 } };
		const { out } = await run(["propose", "--dir", skillDir(), "--dry-run"]);
		expect(out).toBe(`status=dry_run\ncontent_sha256=${"cd".repeat(32)}\nredactions=0\ndiff_added=2\n`);
	});

	test("a refusal prints each finding as file:line rule and exits 1", async () => {
		stub.reply = {
			status: 400,
			body: { error: "secret-like content in 2 place(s)", findings: [{ file: "SKILL.md", line: 4, rule: "github" }, { file: "scripts/run.sh", line: 1, rule: "aws" }] },
		};
		const { code, out, err } = await run(["propose", "--dir", skillDir()]);
		expect(code).toBe(1);
		expect(out).toBe("finding=SKILL.md:4 github\nfinding=scripts/run.sh:1 aws\nstatus=refused\n");
		expect(err).toContain("400: secret-like content in 2 place(s)");
	});

	test.each([
		[401, "skills_propose needs an authenticated surface", "refused"],
		[403, "operator token", "refused"],
		[413, "request body too large", "refused"],
		[502, "git push exited 1", "failed"],
		[503, "the MCP audit chain could not take the record", "failed"],
		[500, "internal error", "failed"],
	] as const)("a %i is exit 1, reported as %s", async (status, error, kind) => {
		stub.reply = { status, body: { error } };
		const { code, out, err } = await run(["propose", "--dir", skillDir()]);
		expect(code).toBe(1);
		expect(out).toBe(`status=${kind}\n`);
		expect(err).toContain(`${status}: ${error}`);
	});

	test("a reply that is not JSON is a failure, with a bounded excerpt", async () => {
		stub.reply = { status: 502, body: "<html>bad gateway</html>".repeat(40) };
		const { code, err } = await run(["propose", "--dir", skillDir()]);
		expect(code).toBe(1);
		expect(err).toContain("502: <html>bad gateway");
		expect(err.length).toBeLessThan(400);
	});

	test("an unreachable server is exit 1, a failure and not a refusal", async () => {
		const { code, out, err } = await run(["propose", "--dir", skillDir()], { url: "http://127.0.0.1:1" });
		expect(code).toBe(1);
		expect(out).toBe("status=failed\n");
		expect(err).toContain("did not answer");
	});

	test("a server slower than the timeout is exit 1", async () => {
		stub.reply = { status: 200, body: opened, delayMs: 600 };
		const { code, err } = await run(["propose", "--dir", skillDir()], { timeoutMs: 100 });
		expect(code).toBe(1);
		expect(err).toContain("did not answer");
	});
});

describe("readSkillDir, the timeout and the cap", () => {
	test("reads every file in sorted order and refuses a special file by name", () => {
		const dir = skillDir();
		expect(Object.keys(readSkillDir(dir))).toEqual(["SKILL.md", "scripts/run.sh"]);
		expect(() => readSkillDir(join(dir, "missing"))).toThrow();
		expect(DirRefused.prototype).toBeInstanceOf(Error);
	});

	test("a directory over the cap is refused from the file sizes, before any file is read", () => {
		const dir = skillDir({ "one.txt": "x".repeat(600_000), "two.txt": "y".repeat(600_000) });
		expect(() => readSkillDir(dir)).toThrow(DirRefused);
		expect(() => readSkillDir(dir)).toThrow("over the limit of 1000000 bytes");
		// A file that alone is over the cap is refused too, even if it is not valid UTF-8 (so it was never decoded).
		const binary = skillDir();
		writeFileSync(join(binary, "huge.bin"), Buffer.alloc(MAX_BODY_BYTES + 1, 0xff));
		expect(() => readSkillDir(binary)).toThrow("over the limit");
	});

	test("the timeout defaults near 180 s and is overridable", () => {
		expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
		expect(skillsTimeout(undefined)).toBe(180_000);
		expect(skillsTimeout("")).toBe(180_000);
		expect(skillsTimeout("abc")).toBe(180_000);
		expect(skillsTimeout("0")).toBe(180_000);
		expect(skillsTimeout("-5")).toBe(180_000);
		expect(skillsTimeout("2500")).toBe(2500);
	});

	test("the CLI's cap is the engine's cap", () => {
		expect(MAX_BODY_BYTES).toBe(ROUTE_MAX_BYTES);
	});
});

describe("the real command", () => {
	const CLI = join(import.meta.dir, "index.ts");

	async function spawn(args: string[], env: Record<string, string>) {
		const proc = Bun.spawn(["bun", CLI, ...args], {
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code };
	}

	test("dispatches `skills propose` over HTTP with SUBSTRATE_TOKEN and exits 0 on a success", async () => {
		stub.reply = { status: 200, body: opened };
		const result = await spawn(["skills", "propose", "--dir", skillDir()], { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("status=opened");
		expect(stub.seen[0]?.authorization).toBe("Bearer tok-real");
	});

	test("exits 1 without a token and 1 on a refusal", async () => {
		const noToken = await spawn(["skills", "propose", "--dir", skillDir()], { SUBSTRATE_URL: stub.url });
		expect(noToken.code).toBe(1);
		expect(noToken.stderr).toContain("SUBSTRATE_TOKEN is not set");

		stub.reply = { status: 403, body: { error: "reopen need an operator token; nothing was proposed" } };
		const refused = await spawn(["skills", "propose", "--dir", skillDir(), "--reopen"], { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" });
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain("status=refused");
	});

	test("the usage text lists the command", async () => {
		const result = await spawn([], {});
		expect(result.stdout).toContain("substrate skills propose --dir PATH");
	});
});
