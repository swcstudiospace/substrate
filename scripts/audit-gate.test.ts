import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { type AcceptedRisk, type AuditJson, filterAdvisories, formatReport, installedVersions, main, parseAllowlist } from "./audit-gate.ts";

const PI_URL = "https://github.com/advisories/GHSA-jfgx-wxx8-mp94";
const FTP_URL = "https://github.com/advisories/GHSA-c475-qrg2-pj4r";
const LOW_URL = "https://github.com/advisories/GHSA-r95r-rj6r-c39x";

const PI = "@mariozechner/pi-coding-agent";
const risk: AcceptedRisk = {
	id: "GHSA-jfgx-wxx8-mp94",
	package: PI,
	version: "0.60.0",
	severity: "high",
	reason: "fixture",
	owner: "fixture-owner",
	review_by: "2027-01-19",
};
const installed = new Map([
	[PI, new Set(["0.60.0"])],
	["basic-ftp", new Set(["5.3.1"])],
]);
const audit: AuditJson = {
	[PI]: [
		{ id: 1123902, url: PI_URL, title: "Pi Agent: extension install paths", severity: "high", vulnerable_versions: ">=0.50.0 <=0.73.1" },
		{ id: 1123905, url: LOW_URL, title: "Pi Agent: auth.json race", severity: "low" },
	],
};
const TODAY = "2026-10-21";

describe("filterAdvisories", () => {
	test("an allowlisted high advisory passes and is reported as accepted", () => {
		const result = filterAdvisories(audit, installed, [risk], TODAY);
		expect(result.failing).toEqual([]);
		expect(result.accepted.map((entry) => entry.finding.id)).toEqual(["GHSA-jfgx-wxx8-mp94"]);
		expect(result.accepted[0]?.risk.owner).toBe("fixture-owner");
		expect(result.warnings).toEqual([]);
	});

	test("an unlisted high advisory fails the gate, and so does an unlisted critical one", () => {
		const withFtp: AuditJson = {
			...audit,
			"basic-ftp": [{ id: 1240853, url: FTP_URL, title: "basic-ftp", severity: "high" }],
			[PI]: [...(audit[PI] ?? []), { id: 2, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "crit", severity: "critical" }],
		};
		const result = filterAdvisories(withFtp, installed, [risk], TODAY);
		expect(result.failing.map((finding) => finding.id).sort()).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-c475-qrg2-pj4r"]);
		expect(result.failing.find((finding) => finding.id === "GHSA-c475-qrg2-pj4r")).toMatchObject({ package: "basic-ftp", version: "5.3.1", severity: "high" });
		expect(result.accepted).toHaveLength(1);
	});

	test("a low or moderate advisory is ignored, even when unlisted", () => {
		const result = filterAdvisories(audit, installed, [risk], TODAY);
		expect(result.failing).toEqual([]);
		expect(result.accepted).toHaveLength(1);
	});

	test("an allowlisted advisory 31 days before its review_by does not warn", () => {
		const result = filterAdvisories(audit, installed, [risk], "2026-12-19");
		expect(result.failing).toEqual([]);
		expect(result.expired).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("an allowlisted advisory 30 days before its review_by warns with its id, package and date and still passes", () => {
		const result = filterAdvisories(audit, installed, [risk], "2026-12-20");
		expect(result.failing).toEqual([]);
		expect(result.expired).toEqual([]);
		expect(result.accepted).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("GHSA-jfgx-wxx8-mp94");
		expect(result.warnings[0]).toContain(PI);
		expect(result.warnings[0]).toContain("2027-01-19");
	});

	test("an allowlisted advisory on its review_by day passes with a warning", () => {
		const result = filterAdvisories(audit, installed, [risk], "2027-01-19");
		expect(result.failing).toEqual([]);
		expect(result.expired).toEqual([]);
		expect(result.accepted).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
	});

	test("an allowlisted advisory the day after its review_by is expired and fails the gate", () => {
		const result = filterAdvisories(audit, installed, [risk], "2027-01-20");
		expect(result.failing).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.expired).toEqual(["accepted risk GHSA-jfgx-wxx8-mp94 expired on 2027-01-19: re-review or upgrade"]);
		expect(formatReport(result, 2)).toContain("FAIL      accepted risk GHSA-jfgx-wxx8-mp94 expired on 2027-01-19: re-review or upgrade");
	});

	test("an allowlisted advisory fails when the lockfile moves to another version", () => {
		const upgraded = new Map([[PI, new Set(["0.61.0"])]]);
		const result = filterAdvisories(audit, upgraded, [risk], TODAY);
		expect(result.accepted).toEqual([]);
		expect(result.failing[0]).toMatchObject({ id: "GHSA-jfgx-wxx8-mp94", version: "0.61.0" });
	});

	test("an allowlisted advisory whose severity rose above the allowlisted one fails until re-reviewed", () => {
		const raised: AuditJson = { [PI]: [{ id: 1123902, url: PI_URL, title: "Pi Agent: extension install paths", severity: "critical" }] };
		const result = filterAdvisories(raised, installed, [risk], TODAY);
		expect(result.accepted).toEqual([]);
		expect(result.failing).toHaveLength(1);
		expect(result.failing[0]).toMatchObject({ id: "GHSA-jfgx-wxx8-mp94", severity: "critical" });
	});

	test("an allowlisted advisory fails when the package is installed at more than one version", () => {
		const duplicated = new Map([[PI, new Set(["0.60.0", "0.61.0"])]]);
		const result = filterAdvisories(audit, duplicated, [risk], TODAY);
		expect(result.accepted).toEqual([]);
		expect(result.failing).toHaveLength(1);
	});

	test("an advisory with no GHSA url is matched on its numeric id", () => {
		const numeric: AuditJson = { [PI]: [{ id: 42, title: "no url", severity: "high" }] };
		const result = filterAdvisories(numeric, installed, [{ ...risk, id: "42" }], TODAY);
		expect(result.failing).toEqual([]);
		expect(result.accepted).toHaveLength(1);
	});
});

describe("installedVersions", () => {
	test("collects every version bun.lock installs, including nested entries", () => {
		const lock = [
			"{",
			'  "packages": {',
			'    "basic-ftp": ["basic-ftp@5.3.1", "", {}, "sha512-x"],',
			'    "proxy-agent/basic-ftp": ["basic-ftp@6.2.1", "", {}, "sha512-y"],',
			'    "@mariozechner/pi-coding-agent": ["@mariozechner/pi-coding-agent@0.60.0", "", {}, "sha512-z"],',
			"  }",
			"}",
		].join("\n");
		const versions = installedVersions(lock);
		expect([...(versions.get("basic-ftp") ?? [])]).toEqual(["5.3.1", "6.2.1"]);
		expect([...(versions.get(PI) ?? [])]).toEqual(["0.60.0"]);
	});
});

describe("parseAllowlist", () => {
	test("accepts the repository allowlist shape and rejects a missing field", () => {
		expect(parseAllowlist(JSON.stringify({ accepted: [risk] }))).toEqual([risk]);
		const { owner: _owner, ...incomplete } = risk;
		expect(() => parseAllowlist(JSON.stringify({ accepted: [incomplete] }))).toThrow("missing owner");
		expect(() => parseAllowlist(JSON.stringify({ accepted: [{ ...risk, review_by: "19/01/2027" }] }))).toThrow("YYYY-MM-DD");
	});
});

describe("main", () => {
	test("exits 2 for malformed audit output instead of skipping the records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "audit-gate-"));
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const file = join(dir, "audit.json");
			for (const body of ['{"basic-ftp":[{}]}', '{"basic-ftp":{}}', '{"basic-ftp":[null]}', '{"basic-ftp":[{"id":1,"url":5,"severity":"high"}]}', "[]"]) {
				await writeFile(file, body);
				expect(await main(["--input", file])).toBe(2);
			}
		} finally {
			stderr.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** Runs `main` on a temp root holding the lockfile, an allowlist with `reviewBy`, and a saved audit of the allowlisted advisory. */
	async function runWithReviewBy(reviewBy: string): Promise<{ code: number; stdout: string }> {
		const dir = await mkdtemp(join(tmpdir(), "audit-gate-"));
		let stdout = "";
		const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		try {
			await mkdir(join(dir, ".github"), { recursive: true });
			await writeFile(join(dir, "bun.lock"), `{\n  "packages": {\n    "${PI}": ["${PI}@0.60.0", "", {}, "sha512-z"],\n  }\n}\n`);
			await writeFile(join(dir, ".github", "audit-accepted-risk.json"), JSON.stringify({ accepted: [{ ...risk, review_by: reviewBy }] }));
			const file = join(dir, "audit.json");
			await writeFile(file, JSON.stringify(audit));
			const code = await main(["--input", file], dir);
			return { code, stdout };
		} finally {
			write.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	}

	test("exits 1 and names the entry when an accepted risk is past its review_by date", async () => {
		// `main` reads the real clock, so the dates are far enough away to hold on any day.
		const { code, stdout } = await runWithReviewBy("2020-01-01");
		expect(code).toBe(1);
		expect(stdout).toContain(`accepted risk ${risk.id} expired on 2020-01-01`);
		expect(stdout).toContain("1 expired");
	});

	test("exits 0 when the accepted risk is far from its review_by date", async () => {
		const { code, stdout } = await runWithReviewBy("2999-01-01");
		expect(code).toBe(0);
		expect(stdout).not.toContain("expired on");
		expect(stdout).toContain("0 expired");
	});
});
