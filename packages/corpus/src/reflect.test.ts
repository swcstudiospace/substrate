import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DIGEST_PATH, MAX_DIGEST_CHARS } from "./protocol.ts";
import {
	DIGEST_KEY_PREFIX,
	DIGEST_MAX_DECISION_CHARS,
	DIGEST_MAX_DECISIONS,
	DIGEST_MAX_ITEM_CHARS,
	DIGEST_MAX_OPEN_ITEMS,
	type DigestSource,
	buildDigest,
} from "./reflect.ts";
import { defined } from "./test-support.ts";

const STATE = `---
gsd_state_version: "1.0"
milestone: v1.7
milestone_name: Docs Atlas and Self-Improving Context
status: executing
last_updated: "2026-10-29T13:00:00.000Z"
current_phase: 66
current_phase_name: docs-reflect
---

# State

## Current Position

Phase: 66 (Docs Reflect) of v1.7 (phases 63-70)
Plan: none written
Status: Executing. Telemetry and feedback are merged.

## Decisions

- [Phase 63]: manifest key is (repo, path)
- [Phase 64]: embeddings are cached
- [Phase 65]: the watcher debounces

## Run notes

- not a decision, a note
`;

const ROADMAP = `# Roadmap: Agent Substrate

<details>
<summary>v1.6 shipped</summary>

- [ ] Phase 61: an archived item that was never ticked
- [x] Phase 62: done

</details>

## Phases

- [x] **Phase 63: Corpus Atlas** - done
- [ ] **Phase 66: Docs Reflect** - retrieval telemetry
- [ ] **Phase 67: Live Steering GA** - steering
`;

const PROJECT = `---
name: x
---

# Agent Substrate

Shared memory and coordination for coding agents.

## What this is

More text.
`;

function sources(overrides: Partial<Record<"state" | "roadmap" | "project", string | null>> = {}): DigestSource[] {
	const files: DigestSource[] = [];
	const add = (path: string, text: string | null | undefined): void => {
		if (text !== null && text !== undefined) files.push({ path, text });
	};
	add(".planning/STATE.md", overrides.state === undefined ? STATE : overrides.state);
	add(".planning/ROADMAP.md", overrides.roadmap === undefined ? ROADMAP : overrides.roadmap);
	add(".planning/PROJECT.md", overrides.project === undefined ? PROJECT : overrides.project);
	return files;
}

function digestOf(files: readonly DigestSource[], repo = "Acme/Alpha") {
	return defined(buildDigest(repo, files), "digest");
}

describe("buildDigest content", () => {
	test("writes the fixed sections in order with the position, decisions newest first, open items and project", () => {
		const digest = digestOf(sources());
		expect(digest.text).toBe(
			[
				"# Documentation digest: Acme/Alpha",
				"",
				"## Current position",
				"- Milestone: v1.7 (Docs Atlas and Self-Improving Context)",
				"- Phase: 66 (docs-reflect)",
				"- State status: executing",
				"- Position: 66 (Docs Reflect) of v1.7 (phases 63-70)",
				"- Status: Executing. Telemetry and feedback are merged.",
				"",
				"## Recent decisions (newest first)",
				"- [Phase 65]: the watcher debounces",
				"- [Phase 64]: embeddings are cached",
				"- [Phase 63]: manifest key is (repo, path)",
				"",
				"## Open items (unchecked in the live roadmap)",
				"- Phase 66: Docs Reflect - retrieval telemetry",
				"- Phase 67: Live Steering GA - steering",
				"",
				"## Project",
				"- Name: Agent Substrate",
				"- Summary: Shared memory and coordination for coding agents.",
				"",
			].join("\n"),
		);
	});

	test("carries the virtual path, a deterministic key and the sha256 of exactly its text", () => {
		const digest = digestOf(sources());
		expect(digest.path).toBe(DIGEST_PATH);
		expect(digest.key).toBe(`${DIGEST_KEY_PREFIX}Acme/Alpha`);
		expect(digest.key).toBe("corpus-digest:Acme/Alpha");
		expect(digest.sha256).toBe(createHash("sha256").update(digest.text, "utf8").digest("hex"));
		expect(digest.repo).toBe("Acme/Alpha");
	});

	test("contains no time: the last_updated stamp and a changed one leave the digest byte-identical", () => {
		const first = digestOf(sources());
		const second = digestOf(sources({ state: STATE.replace("2026-10-29T13:00:00.000Z", "2027-01-01T00:00:00.000Z") }));
		expect(first.text).not.toContain("2026");
		expect(second.text).toBe(first.text);
		expect(second.sha256).toBe(first.sha256);
		expect(digestOf(sources()).text).toBe(first.text);
	});

	test("does not depend on the order of the source files", () => {
		const files = sources();
		expect(digestOf([...files].reverse()).text).toBe(digestOf(files).text);
	});

	test("a changed source changes the digest", () => {
		const first = digestOf(sources());
		const second = digestOf(sources({ state: STATE.replace("- [Phase 65]: the watcher debounces", "- [Phase 65]: the watcher polls") }));
		expect(second.sha256).not.toBe(first.sha256);
		expect(second.text).toContain("the watcher polls");
	});

	test("reads decisions only from sections headed with Decisions and stops at the next heading of the same level", () => {
		const text = ["## Decisions", "", "- one", "### Operator decisions", "- two", "## Notes", "- three"].join("\n");
		const digest = digestOf(sources({ state: text }));
		expect(digest.text).toContain("- two\n- one\n");
		expect(digest.text).not.toContain("three");
	});

	test("lists only the newest decisions, each cut to its limit, and says so with an ellipsis", () => {
		const items = Array.from({ length: DIGEST_MAX_DECISIONS + 15 }, (_, index) => `- decision ${index + 1}`);
		items.push(`- ${"long ".repeat(200)}end`);
		const digest = digestOf(sources({ state: `## Decisions\n\n${items.join("\n")}\n` }));
		const section = digest.text.split("## Recent decisions (newest first)\n")[1]?.split("\n\n")[0] ?? "";
		const listed = section.split("\n");
		expect(listed.length).toBe(DIGEST_MAX_DECISIONS);
		const newest = defined(listed[0], "newest");
		expect(newest.length).toBeLessThanOrEqual(DIGEST_MAX_DECISION_CHARS + 2);
		expect(newest.endsWith("...")).toBe(true);
		expect(listed[1]).toBe(`- decision ${DIGEST_MAX_DECISIONS + 15}`);
		expect(digest.text).not.toContain("decision 1\n");
	});

	test("open items skip archived <details> blocks and checked boxes, keep roadmap order and are capped", () => {
		const boxes = Array.from({ length: DIGEST_MAX_OPEN_ITEMS + 5 }, (_, index) => `- [ ] item ${index + 1}`);
		const roadmap = `<details>\n- [ ] archived\n</details>\n- [x] ticked\n${boxes.join("\n")}\n- [ ] ${"x".repeat(500)}\n`;
		const digest = digestOf(sources({ roadmap }));
		const section = digest.text.split("## Open items (unchecked in the live roadmap)\n")[1]?.split("\n\n")[0] ?? "";
		const listed = section.split("\n");
		expect(listed.length).toBe(DIGEST_MAX_OPEN_ITEMS);
		expect(listed[0]).toBe("- item 1");
		expect(digest.text).not.toContain("archived");
		expect(digest.text).not.toContain("ticked");
		const longRoadmap = digestOf(sources({ roadmap: `- [ ] ${"x".repeat(500)}\n` }));
		const longLine = defined(longRoadmap.text.split("\n").find((line) => line.startsWith("- xxx")), "long line");
		expect(longLine.length).toBeLessThanOrEqual(DIGEST_MAX_ITEM_CHARS + 2);
	});

	test("a <details> block that closes on the same line, and nested blocks, are handled", () => {
		const roadmap = "<details><summary>old</summary>\n- [ ] hidden\n<details>\n- [ ] hidden too\n</details>\n- [ ] still hidden\n</details>\n- [ ] shown\n";
		const digest = digestOf(sources({ roadmap }));
		expect(digest.text).toContain("- shown");
		expect(digest.text).not.toContain("hidden");
	});

	test("a missing section says none found, and a missing PROJECT drops only its own lines", () => {
		const digest = digestOf(sources({ state: "# State\n", roadmap: "# Roadmap\n", project: null }));
		expect(digest.text).toBe(
			[
				"# Documentation digest: Acme/Alpha",
				"",
				"## Current position",
				"- none found",
				"",
				"## Recent decisions (newest first)",
				"- none found",
				"",
				"## Open items (unchecked in the live roadmap)",
				"- none found",
				"",
				"## Project",
				"- none found",
				"",
			].join("\n"),
		);
	});

	test("works from the roadmap alone and from the state alone", () => {
		const roadmapOnly = digestOf(sources({ state: null }));
		expect(roadmapOnly.text).toContain("- Phase 67: Live Steering GA");
		expect(roadmapOnly.text).toContain("## Current position\n- none found");
		const stateOnly = digestOf(sources({ roadmap: null }));
		expect(stateOnly.text).toContain("- Milestone: v1.7");
		expect(stateOnly.text).toContain("## Open items (unchecked in the live roadmap)\n- none found");
	});

	test("reads CRLF files and a leading byte-order mark the same as LF files", () => {
		const lf = digestOf(sources());
		const crlf = digestOf(sources({ state: `\uFEFF${STATE.replace(/\n/g, "\r\n")}`, roadmap: ROADMAP.replace(/\n/g, "\r\n"), project: PROJECT.replace(/\n/g, "\r\n") }));
		expect(crlf.text).toBe(lf.text);
	});

	test("control characters and emphasis markers never reach the text, and one line stays one line", () => {
		const state = "## Decisions\n- **bold** a\u0000b\u001b[31m c\td\u007fe\n";
		const digest = digestOf(sources({ state }));
		expect(digest.text).toContain("- bold a b [31m c d e\n");
		for (const char of digest.text) {
			const code = char.charCodeAt(0);
			expect(code === 0x0a || (code >= 0x20 && code !== 0x7f)).toBe(true);
		}
	});

	test("a Unicode line separator ends a line like a newline and loses no bullet", () => {
		const digest = digestOf(sources({ state: "## Decisions\n- first\u2028- second\u2029- third\n" }));
		expect(digest.text).toContain("- third\n- second\n- first\n");
	});

	test("the worst case, every cap reached with surrogate pairs, fits the server limit and stays well-formed", () => {
		const wide = "\u{1F600}".repeat(400);
		const frontMatter = ["milestone", "milestone_name", "status", "current_phase", "current_phase_name"].map((key) => `${key}: ${wide}`).join("\n");
		const state = `---\n${frontMatter}\n---\nPhase: ${wide}\nStatus: ${wide}\n## Decisions\n${Array.from({ length: 50 }, () => `- ${wide}`).join("\n")}\n`;
		const roadmap = Array.from({ length: 500 }, () => `- [ ] ${wide}`).join("\n");
		const project = `# ${wide}\n\n${wide}\n`;
		const digest = digestOf(sources({ state, roadmap, project }), `Acme/${"r".repeat(190)}`);
		expect(digest.text.length).toBeLessThan(MAX_DIGEST_CHARS);
		expect(digest.text.endsWith("\n")).toBe(true);
		expect(Buffer.from(digest.text, "utf8").toString("utf8")).toBe(digest.text);
	});
});

describe("buildDigest inputs", () => {
	test("is null when the repository has neither STATE nor ROADMAP, and PROJECT alone is not enough", () => {
		expect(buildDigest("Acme/Alpha", [])).toBeNull();
		expect(buildDigest("Acme/Alpha", [{ path: ".planning/PROJECT.md", text: PROJECT }])).toBeNull();
		expect(buildDigest("Acme/Alpha", [{ path: "README.md", text: "# hi" }])).toBeNull();
	});

	test("matches the planning files by exact lowercase path from the root, not nested ones", () => {
		expect(buildDigest("Acme/Alpha", [{ path: ".Planning/state.MD", text: STATE }])).not.toBeNull();
		expect(buildDigest("Acme/Alpha", [{ path: "packages/x/.planning/STATE.md", text: STATE }])).toBeNull();
	});

	test("an empty STATE still gives a digest", () => {
		expect(buildDigest("Acme/Alpha", [{ path: ".planning/STATE.md", text: "" }])).not.toBeNull();
	});
});
