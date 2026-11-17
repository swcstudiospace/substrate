/**
 * The generated configuration reference cannot drift (uplift-5 U5-7).
 *
 * What each test proves, and the bug it would catch:
 * - the committed `docs/config-reference.md` and the evidence table inside
 *   `docs/runbooks/flag-promotion.md` equal what the registry renders, so a
 *   registry change without regenerating (a new flag, a changed threshold) fails
 *   here rather than leaving the operator reading a stale number;
 * - `--check` really detects drift (a stale table, a lost marker) and writes
 *   nothing, and the write mode brings a drifted tree back to a clean check;
 * - every registered name is in the document and every table row has the right
 *   number of columns (a registry value with a `|` must not split a cell).
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAG_FAMILIES, FLAGS, REGISTRY_EXEMPT, policyFlags } from "../packages/mcp-server/src/flag-registry.ts";
import { EVIDENCE_BEGIN, EVIDENCE_END, REFERENCE_PATH, RUNBOOK_PATH, main, renderEvidenceTable, renderReference, spliceEvidence } from "./config-reference.ts";
import { defined } from "./test-support.ts";

const ROOT = join(import.meta.dir, "..");

function check(root: string, argv: readonly string[] = ["--check"]): { code: number; stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	const code = main(argv, {
		root,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stdout, stderr };
}

/** A scratch tree holding copies of the two committed documents. */
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "config-reference-"));
	mkdirSync(join(root, "docs", "runbooks"), { recursive: true });
	cpSync(join(ROOT, REFERENCE_PATH), join(root, REFERENCE_PATH));
	cpSync(join(ROOT, RUNBOOK_PATH), join(root, RUNBOOK_PATH));
	return root;
}

describe("the committed documents match the registry", () => {
	test("--check passes on the repository's committed documents and writes nothing", () => {
		const before = [readFileSync(join(ROOT, REFERENCE_PATH), "utf8"), readFileSync(join(ROOT, RUNBOOK_PATH), "utf8")];
		const result = check(ROOT);
		expect(result).toEqual({ code: 0, stdout: "config reference: up to date\n", stderr: "" });
		expect([readFileSync(join(ROOT, REFERENCE_PATH), "utf8"), readFileSync(join(ROOT, RUNBOOK_PATH), "utf8")]).toEqual(before);
	});

	test("the runbook's evidence table lists every criterion of every policy flag, each as a proposal", () => {
		const runbook = readFileSync(join(ROOT, RUNBOOK_PATH), "utf8");
		const table = runbook.slice(runbook.indexOf(EVIDENCE_BEGIN), runbook.indexOf(EVIDENCE_END));
		for (const flag of policyFlags()) {
			for (const evidence of defined(flag.policy, "policy").evidence) {
				expect({ flag: flag.name, id: evidence.id, listed: table.includes(evidence.id) }).toEqual({ flag: flag.name, id: evidence.id, listed: true });
			}
		}
		expect(table.match(/PROPOSED/g)?.length).toBe(policyFlags().flatMap((flag) => defined(flag.policy, "policy").evidence).length);
		expect(runbook).toContain("proposals");
	});
});

describe("--check detects drift", () => {
	test("a stale reference and a hand-edited evidence table are both reported, by file, with exit 1", () => {
		const root = scratch();
		try {
			writeFileSync(join(root, REFERENCE_PATH), `${readFileSync(join(root, REFERENCE_PATH), "utf8")}\nhand edit\n`);
			const runbook = readFileSync(join(root, RUNBOOK_PATH), "utf8");
			writeFileSync(join(root, RUNBOOK_PATH), runbook.replace("| 100 |", "| 7 |"));
			const result = check(root);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(REFERENCE_PATH);
			expect(result.stderr).toContain(RUNBOOK_PATH);
			expect(result.stdout).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a runbook that has lost its markers, or a missing reference, fails the check instead of passing", () => {
		const root = scratch();
		try {
			writeFileSync(join(root, RUNBOOK_PATH), readFileSync(join(root, RUNBOOK_PATH), "utf8").replace(EVIDENCE_END, ""));
			expect(check(root).code).toBe(1);
			expect(check(root).stderr).toContain("markers");
			cpSync(join(ROOT, RUNBOOK_PATH), join(root, RUNBOOK_PATH));
			rmSync(join(root, REFERENCE_PATH));
			expect(check(root).code).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("write mode repairs a drifted tree and leaves no temporary file; the check then passes", () => {
		const root = scratch();
		try {
			writeFileSync(join(root, REFERENCE_PATH), "stale\n");
			const written = check(root, []);
			expect(written.code).toBe(0);
			expect(readFileSync(join(root, REFERENCE_PATH), "utf8")).toBe(renderReference());
			expect(check(root).code).toBe(0);
			expect(readdirSync(join(root, "docs")).filter((name) => name.includes(".tmp-"))).toEqual([]);
			expect(readdirSync(join(root, "docs", "runbooks")).filter((name) => name.includes(".tmp-"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unknown argument is a usage error (2), not a silent write", () => {
		const root = scratch();
		try {
			writeFileSync(join(root, REFERENCE_PATH), "stale\n");
			expect(check(root, ["--bogus"]).code).toBe(2);
			expect(readFileSync(join(root, REFERENCE_PATH), "utf8")).toBe("stale\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("splicing replaces only what is between the markers and refuses a runbook without them", () => {
		const table = renderEvidenceTable();
		const doc = `before\n${EVIDENCE_BEGIN}\n\nstale-placeholder-row\n\n${EVIDENCE_END}\nafter\n`;
		const spliced = defined(spliceEvidence(doc, table), "spliced runbook");
		expect(spliced.startsWith(`before\n${EVIDENCE_BEGIN}`)).toBe(true);
		expect(spliced.endsWith(`${EVIDENCE_END}\nafter\n`)).toBe(true);
		expect(spliced).not.toContain("stale-placeholder-row");
		expect(spliced).toContain(table);
		expect(spliceEvidence("no markers", table)).toBeNull();
		expect(spliceEvidence(`${EVIDENCE_END}\n${EVIDENCE_BEGIN}`, table)).toBeNull();
	});
});

describe("the rendered reference is complete and well-formed", () => {
	const text = renderReference();

	test("every registered name, family pattern and exempt name appears in it", () => {
		const missing = [
			...FLAGS.map((flag) => flag.name),
			...FLAG_FAMILIES.map((family) => family.pattern.replace(/\|/g, "\\|")),
			...REGISTRY_EXEMPT.map((entry) => entry.name),
		].filter((name) => !text.includes(`\`${name}\``));
		expect(missing).toEqual([]);
	});

	test("every table row has as many unescaped columns as its header (a `|` in a value is escaped, not a new cell)", () => {
		const cells = (line: string): number => line.replace(/\\\|/g, "").split("|").length;
		let header = 0;
		const bad: string[] = [];
		for (const line of text.split("\n")) {
			if (!line.startsWith("|")) {
				header = 0;
				continue;
			}
			if (header === 0) header = cells(line);
			else if (cells(line) !== header) bad.push(line.slice(0, 80));
		}
		expect(bad).toEqual([]);
		// The value lists that motivated the escape are really in the document.
		expect(text).toContain("1 \\| true \\| yes");
	});

	test("unread and legacy rows say so", () => {
		expect(text).toContain("UNREAD: no code reads it today");
		expect(text).toContain("LEGACY: read only to warn at boot");
	});

	test("the header states the scope: TypeScript under packages/ and scripts/, with the dispatcher and the shell not covered", () => {
		const header = text.slice(0, text.indexOf("## "));
		expect(header).toContain("read by TypeScript under `packages/` and `scripts/`");
		expect(header).toContain("Not covered: the Python dispatcher and the infra shell");
	});

	test("the promotion table has one row per policy flag with its safe and enforcing values", () => {
		for (const flag of policyFlags()) {
			const policy = defined(flag.policy, "policy");
			const row = text.split("\n").find((line) => line.startsWith(`| \`${flag.name}\` | \`${policy.safe}\``));
			expect({ flag: flag.name, row: row !== undefined }).toEqual({ flag: flag.name, row: true });
			expect(row).toContain(`\`${policy.enforcing}\``);
		}
	});
});
