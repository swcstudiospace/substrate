/**
 * Docs lint: a relative markdown link must resolve to a file, and the documents a reader lands on must open with a
 * level-1 title. `docs-lint.test.ts` runs `lintDocs` on the committed tree inside `bun test`, so the CI workflow needs no
 * extra command (see `docs/ci.md`).
 *
 * The link rule covers every markdown file under `docs/` and `.planning/` (archives included) plus the four root documents.
 * The title rule covers `docs/`, the live `.planning/*.md` files and `.planning/phases/`; archived plans under
 * `.planning/milestones/` are copies made by `milestone complete` and are exempt from it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BrokenLink {
	/** Path of the document, relative to the repository root, with `/` separators. */
	readonly file: string;
	/** The link target exactly as written, anchor included. */
	readonly target: string;
}

export interface DocsLintResult {
	readonly brokenLinks: BrokenLink[];
	readonly missingTitles: string[];
}

const ROOT_DOCUMENTS: readonly string[] = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md"];
const LINK_TREES: readonly string[] = ["docs", ".planning"];

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
// A backtick run closed by a run of the same length, so a span holding a shorter run of backticks stays one span.
const INLINE_CODE = /(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)/g;
const LINK_TARGET = /\]\(([^)\s]+)\)/g;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
const TITLE_LINE = /^# \S/;

/** The lines outside fenced code blocks. An unterminated fence runs to the end of the text, as in CommonMark. */
function linesOutsideFences(text: string): string[] {
	const kept: string[] = [];
	let open: { char: string; length: number } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const run = FENCE_LINE.exec(line)?.[1];
		if (open === null) {
			if (run === undefined) kept.push(line);
			else open = { char: run.charAt(0), length: run.length };
			continue;
		}
		if (run !== undefined && run.charAt(0) === open.char && run.length >= open.length && line.trim() === run) open = null;
	}
	return kept;
}

/**
 * The relative markdown links in `text` that resolve to nothing, as written. `dir` is the directory of the document and
 * `exists` answers whether a path is there. Links with a scheme, `#anchors` and absolute paths are not checked, the anchor
 * is stripped before the existence check, and fenced code blocks and inline code are skipped because they show syntax, not links.
 */
export function brokenRelativeLinks(text: string, dir: string, exists: (path: string) => boolean): string[] {
	const broken: string[] = [];
	for (const line of linesOutsideFences(text)) {
		for (const match of line.replace(INLINE_CODE, "").matchAll(LINK_TARGET)) {
			const target = match[1] ?? "";
			if (EXTERNAL_TARGET.test(target)) continue;
			const file = target.split("#")[0] ?? "";
			if (file !== "" && !exists(join(dir, file))) broken.push(target);
		}
	}
	return broken;
}

/** True when the text has no level-1 heading (`# Title`) after an optional YAML front matter block. Headings in code fences do not count. */
export function missingTitle(text: string): boolean {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	let body = lines;
	if (lines[0]?.trimEnd() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."));
		if (close > 0) body = lines.slice(close + 1);
	}
	return !linesOutsideFences(body.join("\n")).some((line) => TITLE_LINE.test(line));
}

/** Whether the title rule applies to a repository-relative path: `docs/`, the live `.planning/*.md` files and `.planning/phases/`. */
function titleRequired(path: string): boolean {
	return path.startsWith("docs/") || path.startsWith(".planning/phases/") || /^\.planning\/[^/]+\.md$/.test(path);
}

/** Markdown files under `relDir` (relative to `root`), sorted, without following symbolic links. A missing directory yields none. */
function markdownUnder(root: string, relDir: string): string[] {
	if (!existsSync(join(root, relDir))) return [];
	const found: string[] = [];
	const entries = readdirSync(join(root, relDir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const rel = `${relDir}/${entry.name}`;
		if (entry.isDirectory()) found.push(...markdownUnder(root, rel));
		else if (entry.isFile() && entry.name.endsWith(".md")) found.push(rel);
	}
	return found;
}

/** Lints the committed documents under `root`. `readFile` is injectable so a test can serve text without touching the disk. */
export function lintDocs(root: string, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): DocsLintResult {
	const files = [...ROOT_DOCUMENTS.filter((name) => existsSync(join(root, name))), ...LINK_TREES.flatMap((tree) => markdownUnder(root, tree))];
	const brokenLinks: BrokenLink[] = [];
	const missingTitles: string[] = [];
	for (const file of files) {
		const path = join(root, file);
		const text = readFile(path);
		for (const target of brokenRelativeLinks(text, dirname(path), existsSync)) brokenLinks.push({ file, target });
		if (titleRequired(file) && missingTitle(text)) missingTitles.push(file);
	}
	return { brokenLinks, missingTitles };
}
