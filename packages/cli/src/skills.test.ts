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
	expandGlob,
	readSkillDir,
	runSkills,
	skillsTimeout,
	type SkillsDeps,
} from "./skills.ts";

interface Seen {
	method: string;
	path: string;
	/** Query string without `?`; empty when the request had none. */
	search: string;
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
			const url = new URL(request.url);
			this.seen.push({
				method: request.method,
				path: url.pathname,
				search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
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

	test("an unknown subcommand is a usage error", async () => {
		const { code, err } = await run(["nope"]);
		expect(code).toBe(2);
		expect(err).toContain("substrate skills propose");
	});

	test("--help prints usage and does not read or post, even when --dir is present", async () => {
		const { code, out } = await run(["propose", "--dir", skillDir(), "--help"]);
		expect(code).toBe(0);
		expect(out).toContain("--dir PATH");
		expect(stub.seen).toEqual([]);
	});

	test("an unknown flag is refused before anything is posted", async () => {
		const { code, err } = await run(["propose", "--dir", skillDir(), "--dryrun"]);
		expect(code).toBe(1);
		expect(err).toContain("unknown flag --dryrun");
		expect(stub.seen).toEqual([]);
	});

	test("a value flag with no value is refused before the directory is read or anything is posted", async () => {
		for (const flag of ["--remove", "--name", "--rationale", "--session", "--graph"]) {
			const { code, err } = await run(["propose", "--dir", join(scratch, "nope"), flag]);
			expect(code).toBe(1);
			expect(err).toContain(`${flag} takes a value`);
		}
		expect(stub.seen).toEqual([]);
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

	test("an empty, array, or unknown-status 200 is a failure", async () => {
		for (const body of [{}, [], { status: "nope", content_sha256: "ab".repeat(32) }, { status: "opened" }]) {
			stub.reply = { status: 200, body };
			const { code, err } = await run(["propose", "--dir", skillDir()]);
			expect({ body, code }).toEqual({ body, code: 1 });
			expect(err).toContain("without a proposal result");
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

describe("skills list", () => {
	const listed = {
		governance: "enforce",
		library: "swcstudiospace/agent-skills",
		truncated: false,
		skills: [
			{
				name: "demo-skill",
				content_sha256: "ab".repeat(32),
				merge_sha: "deadbeef",
				pr_url: "https://github.com/swcstudiospace/agent-skills/pull/12",
				approved_at: "2026-10-14T13:00:00.000Z",
				proposed_by: "cursor",
			},
		],
	};

	test("the default list is GET /skills with an empty query, the bearer and no body", async () => {
		stub.reply = { status: 200, body: listed };
		const { code } = await run(["list"]);
		expect(code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		expect(stub.seen[0]).toMatchObject({ method: "GET", path: "/skills", search: "", authorization: "Bearer tok-agent", body: {} });
	});

	test("list --state all sends state=all", async () => {
		stub.reply = { status: 200, body: { ...listed, skills: [] } };
		await run(["list", "--state", "all"]);
		expect(stub.seen[0]).toMatchObject({ method: "GET", path: "/skills", search: "state=all" });
	});

	test("list without a token records nothing", async () => {
		const { code, out, err } = await run(["list"], { token: undefined });
		expect(code).toBe(1);
		expect(out).toContain("status=refused");
		expect(err).toContain("nothing was sent");
		expect(stub.seen).toEqual([]);
	});

	test("a 200 prints governance, library and one skill line", async () => {
		stub.reply = { status: 200, body: listed };
		const { code, out } = await run(["list"]);
		expect(code).toBe(0);
		expect(out).toContain("governance=enforce");
		expect(out).toContain("library=swcstudiospace/agent-skills");
		expect(out).toContain("truncated=false");
		expect(out).toContain("count=1");
		expect(out).toContain("skill=name=demo-skill");
		expect(out).toContain(`content_sha256=${"ab".repeat(32)}`);
	});

	test("a 403 is refused and exits 1", async () => {
		stub.reply = { status: 403, body: { error: "skills_list of a non-default state needs an operator token" } };
		const { code, out, err } = await run(["list", "--state", "proposed"]);
		expect(code).toBe(1);
		expect(out).toBe("status=refused\n");
		expect(err).toContain("operator token");
		expect(err).not.toContain("tok-agent");
	});

	test("a bad or valueless --state is refused before HTTP", async () => {
		for (const argv of [["list", "--state"], ["list", "--state", "open"]]) {
			const { code, out } = await run(argv);
			expect(code).toBe(1);
			expect(out).toContain("status=refused");
		}
		expect(stub.seen).toEqual([]);
	});
});

describe("skills approve", () => {
	const declined = {
		status: "declined",
		state: "declined",
		name: "demo-skill",
		pr_number: 4,
		pr_url: null,
		merge_sha: null,
		content_sha256: "cd".repeat(32),
		remaining_approved_for_name: 1,
		noted: true,
	};

	test("posts pr_number as a number for decline and for retire", async () => {
		for (const decision of ["decline", "retire"] as const) {
			stub.seen = [];
			stub.reply = { status: 200, body: { ...declined, status: decision === "retire" ? "retired" : "declined", state: decision === "retire" ? "retired" : "declined" } };
			const { code } = await run(["approve", "--name", "demo-skill", "--pr", "4", "--decision", decision, "--reason", "reviewed"]);
			expect(code).toBe(0);
			expect(stub.seen[0]).toMatchObject({ method: "POST", path: "/skills/approve", authorization: "Bearer tok-agent" });
			expect(stub.seen[0]?.body).toEqual({ name: "demo-skill", pr_number: 4, decision, reason: "reviewed" });
			expect(typeof stub.seen[0]?.body.pr_number).toBe("number");
		}
	});

	test("a missing name, a non-integer --pr or a bad decision records nothing", async () => {
		for (const argv of [
			["approve", "--pr", "4", "--decision", "decline"],
			["approve", "--name", "demo-skill", "--pr", "4.5", "--decision", "decline"],
			["approve", "--name", "demo-skill", "--pr", "4", "--decision", "maybe"],
		]) {
			const { code, out } = await run(argv);
			expect(code).toBe(1);
			expect(out).toContain("status=refused");
		}
		expect(stub.seen).toEqual([]);
	});
});

describe("readSkillDir, the timeout and the cap", () => {
	test("reads every file in sorted order and refuses a special file by name", () => {
		const dir = skillDir();
		expect(Object.keys(readSkillDir(dir))).toEqual(["SKILL.md", "scripts/run.sh"]);
		writeFileSync(join(dir, "__proto__"), "kept\n");
		const withProto = readSkillDir(dir);
		expect(Object.keys(withProto).sort()).toEqual(["SKILL.md", "__proto__", "scripts/run.sh"]);
		expect(Object.getOwnPropertyDescriptor(withProto, "__proto__")?.value).toBe("kept\n");
		expect(() => readSkillDir(join(dir, "missing"))).toThrow();
		expect(DirRefused.prototype).toBeInstanceOf(Error);
		writeFileSync(join(dir, "notes.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x6f, 0x74, 0x65, 0x73, 0x0a]));
		expect(readSkillDir(dir)["notes.md"]).toBe("\ufeffnotes\n");
		// A marked SKILL.md keeps its bytes too; the server's frontmatter accepts the mark.
		writeFileSync(join(dir, "SKILL.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SKILL_MD)]));
		expect(readSkillDir(dir)["SKILL.md"]).toBe(`\ufeff${SKILL_MD}`);
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
		expect(result.stdout).toContain("substrate skills list");
		expect(result.stdout).toContain("substrate skills approve");
	});

	test("dispatches `skills list` as GET /skills and exits 0", async () => {
		stub.reply = { status: 200, body: { governance: "off", library: "o/r", skills: [], truncated: false } };
		const result = await spawn(["skills", "list"], { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("governance=off");
		expect(stub.seen[0]).toMatchObject({ method: "GET", path: "/skills", search: "", authorization: "Bearer tok-real" });
	});

	test("dispatches `skills approve` as POST /skills/approve and exits 0", async () => {
		stub.reply = {
			status: 200,
			body: { status: "declined", state: "declined", name: "demo-skill", pr_number: 9, pr_url: null, merge_sha: null, content_sha256: "ab".repeat(32), remaining_approved_for_name: 0 },
		};
		const result = await spawn(
			["skills", "approve", "--name", "demo-skill", "--pr", "9", "--decision", "decline"],
			{ SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" },
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("status=declined");
		expect(stub.seen[0]?.body.pr_number).toBe(9);
		expect(stub.seen[0]).toMatchObject({ method: "POST", path: "/skills/approve", authorization: "Bearer tok-real" });
	});
});

describe("proposing several skills at once", () => {
	const batch = [
		{ name: "demo-skill", status: "dry_run", content_sha256: "ab".repeat(32), redactions: [], diff_added: 1, diff_patch: "diff --git a/demo-skill/SKILL.md b/demo-skill/SKILL.md\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
		{ name: "second-skill", status: "dry_run", content_sha256: "cd".repeat(32), redactions: [] },
	];

	test("repeatable --dir posts one { proposals } body with each directory's name and files", async () => {
		stub.reply = { status: 200, body: batch };
		const { code } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "second-skill"), "--dry-run", "--rationale", "drain two", "--session", "s-1"]);
		expect(code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		const body = stub.seen[0]?.body ?? {};
		expect(Object.keys(body).sort()).toEqual(["dry_run", "proposals"]);
		expect(body.dry_run).toBe(true);
		const proposals = body.proposals as Array<Record<string, unknown>>;
		expect(proposals.map((p) => p.name)).toEqual(["demo-skill", "second-skill"]);
		for (const proposal of proposals) {
			expect(proposal.rationale).toBe("drain two");
			expect(proposal.session_id).toBe("s-1");
			expect(Object.keys(proposal.files as object).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
		}
	});

	test("--glob expands to every matching directory, sorted", async () => {
		const root = join(scratch, `team-${counter++}`);
		for (const name of ["beta-skill", "alpha-skill"]) {
			mkdirSync(join(root, "skills", name), { recursive: true });
			writeFileSync(join(root, "skills", name, "SKILL.md"), SKILL_MD.replace("demo-skill", name));
		}
		stub.reply = { status: 200, body: [] };
		const { code } = await run(["propose", "--glob", "skills/*"], { cwd: root });
		expect(code).toBe(0);
		const proposals = (stub.seen[0]?.body.proposals as Array<Record<string, unknown>>) ?? [];
		expect(proposals.map((p) => p.name)).toEqual(["alpha-skill", "beta-skill"]);
	});

	test("the default output prints every item and its unified diff hunks", async () => {
		stub.reply = { status: 200, body: batch };
		const { code, out } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "second-skill"), "--dry-run"]);
		expect(code).toBe(0);
		expect(out).toContain("name=demo-skill\nstatus=dry_run\n");
		expect(out).toContain("name=second-skill\nstatus=dry_run\n");
		expect(out).toContain("diff --git a/demo-skill/SKILL.md");
		expect(out).toContain("+new\n");
	});

	test("--json prints the batch array", async () => {
		stub.reply = { status: 200, body: batch };
		const { code, out } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "second-skill"), "--json"]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual(batch);
	});

	test("one refused item exits 1 but every sibling is still printed", async () => {
		stub.reply = {
			status: 200,
			body: [batch[0], { name: "bad-skill", status: "refused", redactions: [], error: "invalid skill name" }],
		};
		const { code, out, err } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "bad-skill")]);
		expect(code).toBe(1);
		expect(out).toContain("name=demo-skill\nstatus=dry_run\n");
		expect(out).toContain("name=bad-skill\nstatus=refused\n");
		expect(out).toContain("error=invalid skill name");
		expect(err).toContain("one or more proposals were refused or failed");
	});

	test("a malformed batch answer is a failure", async () => {
		stub.reply = { status: 200, body: [{ status: "dry_run" }] };
		const { code, err } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "second-skill")]);
		expect(code).toBe(1);
		expect(err).toContain("without a batch result");
	});

	test("--name and --remove refuse with several directories, and nothing is posted", async () => {
		for (const flags of [["--name", "x"], ["--remove", "a.md"]]) {
			const { code, err } = await run(["propose", "--dir", skillDir(), "--dir", skillDir({}, "second-skill"), ...flags]);
			expect(code).toBe(1);
			expect(err).toContain("applies to a single --dir");
		}
		expect(stub.seen).toEqual([]);
	});

	test("a repeatable --dir with no value, and a glob matching nothing, are refused", async () => {
		for (const argv of [["propose", "--dir", skillDir(), "--dir"], ["propose", "--glob", "nothing/*"]]) {
			const { code, err } = await run(argv);
			expect(code).toBe(1);
			const flag = argv.at(1);
			if (flag === undefined) throw new Error("argv has no flag");
			expect(err).toContain(flag);
		}
		expect(stub.seen).toEqual([]);
	});

	test("a single dry run prints the patch the server sent", async () => {
		stub.reply = { status: 200, body: { status: "dry_run", content_sha256: "ab".repeat(32), redactions: [], diff_patch: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n" } };
		const { code, out } = await run(["propose", "--dir", skillDir(), "--dry-run"]);
		expect(code).toBe(0);
		expect(out).toContain("status=dry_run\n");
		expect(out).toContain("diff --git a/x b/x\n");
		expect(out).toContain("+b\n");
	});

	test("expandGlob rejects absolute and parent patterns", () => {
		for (const pattern of ["/tmp/*", "../*", "skills/../*", "skills/**"]) {
			expect(() => expandGlob(scratch, pattern)).toThrow(DirRefused);
		}
	});
});
