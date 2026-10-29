import { describe, expect, test } from "bun:test";
import { type SupersessionRow, detectSupersession, supersededByMarker } from "./supersession.ts";

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

function row(repo: string, path: string, overrides: Partial<SupersessionRow> = {}): SupersessionRow {
	return { repo, path, sha256: `sha-${repo}-${path}`, tier: 1, kind: "doc", source: "fs", updatedAt: NEW, ...overrides };
}

describe("supersededByMarker", () => {
	test("reads the marker from the opening front matter", () => {
		expect(supersededByMarker("---\ntitle: Old\nsuperseded-by: docs/new.md\n---\n# Old\n")).toBe("docs/new.md");
	});

	test("accepts quotes, a leading ./, CRLF line endings, a byte-order mark and any key case", () => {
		expect(supersededByMarker('---\r\nSuperseded-By: "./docs/new.md"\r\n---\r\n')).toBe("docs/new.md");
		expect(supersededByMarker("\uFEFF---\nsuperseded-by: 'a/b.md'\n---\n")).toBe("a/b.md");
	});

	test("is null without front matter, outside it, or after it closes", () => {
		expect(supersededByMarker("# Title\nsuperseded-by: docs/new.md\n")).toBeNull();
		expect(supersededByMarker("\n---\nsuperseded-by: docs/new.md\n---\n")).toBeNull();
		expect(supersededByMarker("---\ntitle: x\n---\nsuperseded-by: docs/new.md\n")).toBeNull();
		// An opening rule with no closing line is not front matter.
		expect(supersededByMarker("---\ntitle: x\nsuperseded-by: docs/new.md\n")).toBeNull();
		expect(supersededByMarker("")).toBeNull();
	});

	test("a value that is not a relative repository path is no marker", () => {
		for (const value of ["", "https://example.com/new.md", "/etc/new.md", "../new.md", "a/../b.md", "a\\b.md", "a//b.md", "''"]) {
			expect(supersededByMarker(`---\nsuperseded-by: ${value}\n---\n`)).toBeNull();
		}
	});

	test("only the first marker counts and a marker deep in a huge front matter is not read", () => {
		expect(supersededByMarker("---\nsuperseded-by: a.md\nsuperseded-by: b.md\n---\n")).toBe("a.md");
		const filler = "k: v\n".repeat(500);
		expect(supersededByMarker(`---\n${filler}superseded-by: late.md\n---\n`)).toBeNull();
	});
});

describe("detectSupersession rule 1: explicit marker", () => {
	test("flags a document whose marker names an existing row of the same repository", () => {
		const result = detectSupersession([row("Acme/A", "docs/old.md", { supersededBy: "docs/new.md" }), row("Acme/A", "docs/new.md")]);
		expect([...result]).toEqual([["Acme/A:docs/old.md", "Acme/A:docs/new.md"]]);
	});

	test("ignores a marker whose target is missing, itself, another repository, invalid or on a tier 3 row", () => {
		const rows = [
			row("Acme/A", "a.md", { supersededBy: "missing.md" }),
			row("Acme/A", "b.md", { supersededBy: "b.md" }),
			row("Acme/A", "c.md", { supersededBy: "other.md" }),
			row("Acme/B", "other.md"),
			row("Acme/A", "d.md", { supersededBy: "../e.md" }),
			row("Acme/A", "e.md", { supersededBy: "f.md", tier: 3 }),
			row("Acme/A", "f.md"),
		];
		expect(detectSupersession(rows).size).toBe(0);
	});

	test("resolves a chain to its final document", () => {
		const result = detectSupersession([
			row("Acme/A", "v1.md", { supersededBy: "v2.md" }),
			row("Acme/A", "v2.md", { supersededBy: "v3.md" }),
			row("Acme/A", "v3.md"),
		]);
		expect(result.get("Acme/A:v1.md")).toBe("Acme/A:v3.md");
		expect(result.get("Acme/A:v2.md")).toBe("Acme/A:v3.md");
		expect(result.has("Acme/A:v3.md")).toBe(false);
	});

	test("a loop of markers flags none of its members, and a document leading into it is not flagged either", () => {
		const result = detectSupersession([
			row("Acme/A", "a.md", { supersededBy: "b.md" }),
			row("Acme/A", "b.md", { supersededBy: "a.md" }),
			row("Acme/A", "x.md", { supersededBy: "a.md" }),
		]);
		expect(result.size).toBe(0);
	});
});

describe("detectSupersession rule 2: a live document and its milestone archive", () => {
	test("an archived file under a milestone directory is superseded by the live file with the same remainder", () => {
		const result = detectSupersession([
			row("Acme/A", ".planning/milestones/v1.6-phases/ROADMAP.md", { tier: 3, kind: "planning-archive" }),
			row("Acme/A", ".planning/ROADMAP.md", { kind: "planning-roadmap" }),
			row("Acme/A", ".planning/milestones/v1.6/deep/PLAN.md", { tier: 3, kind: "planning-archive" }),
			row("Acme/A", ".planning/deep/PLAN.md", { kind: "planning-other" }),
		]);
		expect(result.get("Acme/A:.planning/milestones/v1.6-phases/ROADMAP.md")).toBe("Acme/A:.planning/ROADMAP.md");
		expect(result.get("Acme/A:.planning/milestones/v1.6/deep/PLAN.md")).toBe("Acme/A:.planning/deep/PLAN.md");
		expect(result.size).toBe(2);
	});

	test("a flat archive named v<version>-<name> is superseded by the live <name>", () => {
		const result = detectSupersession([
			row("Acme/A", ".planning/milestones/v1.6-ROADMAP.md", { tier: 3, kind: "planning-archive" }),
			row("Acme/A", ".planning/ROADMAP.md"),
			row("Acme/A", ".planning/milestones/v1.6-MILESTONE-AUDIT.md", { tier: 2, kind: "planning-audit" }),
		]);
		expect([...result]).toEqual([["Acme/A:.planning/milestones/v1.6-ROADMAP.md", "Acme/A:.planning/ROADMAP.md"]]);
	});

	test("works for a .planning directory below the repository root", () => {
		const result = detectSupersession([
			row("Acme/A", "packages/x/.planning/milestones/v1/STATE.md", { tier: 3 }),
			row("Acme/A", "packages/x/.planning/STATE.md"),
		]);
		expect(result.get("Acme/A:packages/x/.planning/milestones/v1/STATE.md")).toBe("Acme/A:packages/x/.planning/STATE.md");
	});

	test("an archive with no live counterpart is left alone, and a live counterpart of another repository does not count", () => {
		expect(detectSupersession([row("Acme/A", ".planning/milestones/v1/ROADMAP.md", { tier: 3 })]).size).toBe(0);
		expect(
			detectSupersession([row("Acme/A", ".planning/milestones/v1/ROADMAP.md", { tier: 3 }), row("Acme/B", ".planning/ROADMAP.md")]).size,
		).toBe(0);
	});

	test("a phase document is never an archive", () => {
		const result = detectSupersession([
			row("Acme/A", ".planning/phases/66-x/66-CONTEXT.md", { kind: "planning-context" }),
			row("Acme/A", ".planning/66-x/66-CONTEXT.md"),
			row("Acme/A", ".planning/phases/66-x/66-CONTEXT.md.bak"),
		]);
		expect(result.size).toBe(0);
	});
});

describe("detectSupersession rule 3: the same path in two local copy collections", () => {
	test("the older copy is superseded by the newer one when the two differ", () => {
		const result = detectSupersession([
			row("local/old", "docs/guide.md", { updatedAt: OLD }),
			row("local/new", "docs/guide.md", { updatedAt: NEW }),
		]);
		expect([...result]).toEqual([["local/old:docs/guide.md", "local/new:docs/guide.md"]]);
	});

	test("does not depend on the order of the rows", () => {
		const rows = [
			row("local/old", "docs/guide.md", { updatedAt: OLD }),
			row("local/new", "docs/guide.md", { updatedAt: NEW }),
			row("local/old", "x.md", { updatedAt: OLD }),
			row("local/new", "x.md", { updatedAt: NEW }),
		];
		const forward = [...detectSupersession(rows)];
		const backward = [...detectSupersession([...rows].reverse())];
		expect(backward).toEqual(forward);
		expect(forward.length).toBe(2);
	});

	test("leaves alone identical content, equal or unparseable times, groups of three, one repository, other sources and tier 3", () => {
		const same = { sha256: "same" };
		expect(detectSupersession([row("local/a", "p.md", { ...same, updatedAt: OLD }), row("local/b", "p.md", { ...same, updatedAt: NEW })]).size).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: NEW }), row("local/b", "p.md", { updatedAt: NEW })]).size).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: "not a date" }), row("local/b", "p.md", { updatedAt: NEW })]).size).toBe(0);
		expect(
			detectSupersession([
				row("local/a", "p.md", { updatedAt: OLD }),
				row("local/b", "p.md", { updatedAt: "2026-03-01T00:00:00.000Z" }),
				row("local/c", "p.md", { updatedAt: NEW }),
			]).size,
		).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: OLD }), row("local/b", "p.md", { updatedAt: NEW, source: "github" })]).size).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: OLD, tier: 3 }), row("local/b", "p.md", { updatedAt: NEW, tier: 3 })]).size).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: OLD })]).size).toBe(0);
	});

	test("never compares a local copy with a repository that has an origin, or two different paths", () => {
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: OLD }), row("Acme/A", "p.md", { updatedAt: NEW })]).size).toBe(0);
		expect(detectSupersession([row("local/a", "p.md", { updatedAt: OLD }), row("local/b", "q.md", { updatedAt: NEW })]).size).toBe(0);
	});
});

describe("detectSupersession precedence", () => {
	test("an explicit marker wins over the copy rule, which would have pointed at the other copy", () => {
		const result = detectSupersession([
			row("local/a", "p.md", { updatedAt: OLD, supersededBy: "q.md" }),
			row("local/a", "q.md", { updatedAt: NEW }),
			row("local/b", "p.md", { updatedAt: NEW }),
		]);
		expect([...result]).toEqual([["local/a:p.md", "local/a:q.md"]]);
	});

	test("a chain can mix rules and ends at the last document", () => {
		const result = detectSupersession([
			row("local/a", "p.md", { updatedAt: NEW, supersededBy: "q.md" }),
			row("local/a", "q.md", { updatedAt: NEW }),
			row("local/b", "p.md", { updatedAt: OLD }),
		]);
		// local/b:p.md is older than local/a:p.md (rule 3), which follows its marker to q.md (rule 1).
		expect(result.get("local/a:p.md")).toBe("local/a:q.md");
		expect(result.get("local/b:p.md")).toBe("local/a:q.md");
	});

	test("no rows, or rows with nothing to flag, give an empty map", () => {
		expect(detectSupersession([]).size).toBe(0);
		expect(detectSupersession([row("Acme/A", "README.md"), row("Acme/B", "README.md")]).size).toBe(0);
	});
});
