import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { type AcceptedRisk, type AuditJson, filterAdvisories, installedVersions, main, parseAllowlist } from "./audit-gate.ts";

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

	test("an allowlisted advisory past its review_by warns and still passes", () => {
		const result = filterAdvisories(audit, installed, [risk], "2027-01-20");
		expect(result.failing).toEqual([]);
		expect(result.accepted).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("review_by 2027-01-19 has passed");
	});

	test("an allowlisted advisory on its review_by date does not warn yet", () => {
		const result = filterAdvisories(audit, installed, [risk], "2027-01-19");
		expect(result.warnings).toEqual([]);
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
});
