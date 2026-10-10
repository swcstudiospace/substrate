/**
 * The smoke's pure helpers and its isolation pins. The smoke itself drives a live twin and is
 * proved by running it (`bun run smoke:skills-plane`); these pin the pieces it trusts, so a
 * mis-parse cannot turn a failing proof green — and the production-path scan fails the suite if
 * the script ever names a live path or the production port outside a refusal.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDirtyWarnings, countOpenedByName, parseDryRunLine, preflight, type TrailEvent } from "./skills-plane-smoke.ts";

describe("preflight", () => {
	const fixture = {
		SUBSTRATE_URL: "http://127.0.0.1:17410",
		SUBSTRATE_REHEARSAL_SKILLS_STATE: "/tmp/run/skills",
		SUBSTRATE_REHEARSAL_SKILLS_ORIGIN: "/tmp/run/skills-fixture/rehearsal/agent-skills.git",
		SUBSTRATE_REHEARSAL_SKILLS_GH_STATE: "/tmp/run/skills-fixture/gh-state.json",
		SUBSTRATE_REHEARSAL_SKILLS_REPO: "rehearsal/agent-skills",
		SUBSTRATE_REHEARSAL_TOKENS_DIR: "/tmp/run/tokens",
	};

	test("refuses the production port", () => {
		expect(preflight({ ...fixture, SUBSTRATE_URL: "http://127.0.0.1:7410" })).toMatch(/refusing to smoke production/);
	});

	test("refuses a non-loopback host", () => {
		expect(preflight({ ...fixture, SUBSTRATE_URL: "http://10.0.0.8:17410" })).toMatch(/refusing non-loopback smoke host/);
		expect(preflight({ ...fixture, SUBSTRATE_URL: "http://substrate.example:17410" })).toMatch(/refusing non-loopback smoke host/);
	});

	test("refuses a twin without the skills fixture", () => {
		const { SUBSTRATE_REHEARSAL_SKILLS_ORIGIN: _dropped, ...rest } = fixture;
		expect(preflight(rest)).toMatch(/no skills fixture/);
	});

	test("refuses a run directory missing a surface token", () => {
		expect(preflight({ ...fixture, SUBSTRATE_REHEARSAL_TOKENS_DIR: "/tmp/does-not-exist" })).toMatch(/holds no token/);
	});

	test("accepts a loopback twin with the fixture and the four tokens", () => {
		const dir = mkdtempSync(join(tmpdir(), "plane-preflight-"));
		try {
			for (const surface of ["hermes", "omp", "grok-build", "substrate"]) writeFileSync(join(dir, surface), "token\n");
			expect(preflight({ ...fixture, SUBSTRATE_REHEARSAL_TOKENS_DIR: dir })).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseDryRunLine", () => {
	test("reads the bridge's dry-run line", () => {
		expect(parseDryRunLine("[skills-bridge:dry-run] name=demo surface=hermes classification=new records=ab12cd34 reply=dry_run")).toEqual({
			name: "demo",
			surface: "hermes",
			classification: "new",
			records: ["ab12cd34"],
			reply: "dry_run",
		});
	});

	test("a queued file keeps its stem as the record", () => {
		const line = parseDryRunLine("[skills-bridge:dry-run] name=demo surface=omp classification=queued records=demo-dry reply=dry_run");
		expect(line?.classification).toBe("queued");
		expect(line?.records).toEqual(["demo-dry"]);
	});

	test("anything else is null, so noise cannot pass as a verdict", () => {
		expect(parseDryRunLine("")).toBeNull();
		expect(parseDryRunLine("[skills-bridge] proposed=1 rejected=0")).toBeNull();
		expect(parseDryRunLine("[skills-bridge:dry-run] name=demo surface=hermes")).toBeNull();
	});
});

describe("trail read-back", () => {
	test("only this run's opened proposals count, one per surface", () => {
		const names = new Set(["run-a", "run-b"]);
		const events: TrailEvent[] = [
			{ kind: "note", payload: { action: "skill.propose", status: "opened", name: "run-a" } },
			{ kind: "note", payload: { action: "skill.propose", status: "opened", name: "stale-run" } },
			{ kind: "note", payload: { action: "skill.propose", status: "existing", name: "run-a" } },
			{ kind: "note", payload: { action: "skill.propose", status: "opened", name: "run-b" } },
			{ kind: "event", payload: { action: "skill.propose", status: "opened", name: "run-b" } },
		];
		expect(countOpenedByName(events, names)).toEqual({ "run-a": 1, "run-b": 1 });
	});

	test("dirty warnings count only at or after the run start", () => {
		const events: TrailEvent[] = [
			{ kind: "warning", ts: "2026-09-26T09:00:00.000Z", payload: { action: "skills.sync", reason: "dirty" } },
			{ kind: "warning", ts: "2026-09-26T10:00:00.000Z", payload: { action: "skills.sync", reason: "dirty" } },
			{ kind: "warning", ts: "2026-09-26T10:05:00.000Z", payload: { action: "skills.sync", reason: "branch" } },
		];
		expect(countDirtyWarnings(events, "2026-09-26T10:00:00.000Z")).toBe(1);
		expect(countDirtyWarnings(events, "2026-09-26T11:00:00.000Z")).toBe(0);
	});
});

describe("isolation pins", () => {
	const source = readFileSync(join(import.meta.dir, "skills-plane-smoke.ts"), "utf8");

	test("the script keeps the harness guards", () => {
		expect(source).toContain("refuseSmokeUrl");
		expect(source).toContain("preflight");
	});

	test("no live path or production port sits in the script", () => {
		const forbidden = [
			"7410",
			"7411",
			"6420",
			"/root/agent-skills",
			"/root/.hermes",
			"/root/.omp",
			"/root/.grok",
			"/root/.claude",
			"/root/.agents",
			"/root/.cursor",
			"/root/.config/muse",
			"/root/.openclaw",
			"/var/lib/substrate",
			"/etc/substrate",
		];
		for (const literal of forbidden) expect(source).not.toContain(literal);
	});
});
