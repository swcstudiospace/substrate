/**
 * Docs lint: a relative markdown link must resolve to a file, and the documents a reader lands on must open with a
 * level-1 title. `docs-lint.test.ts` runs `lintDocs` on the committed tree inside `bun test`, so the CI workflow needs no
 * extra command (see `docs/ci.md`).
 *
 * The link rule covers every markdown file under `docs/` and `.planning/` (archives included) plus the four root documents.
 * The title rule covers `docs/`, the live `.planning/*.md` files and `.planning/phases/`; archived plans under
 * `.planning/milestones/` are copies made by `milestone complete` and are exempt from it.
 *
 * Links and headings come from Bun's built-in CommonMark parser (`Bun.markdown.render`), not from regular expressions.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BrokenLink {
	/** Path of the document, relative to the repository root, with `/` separators. */
	readonly file: string;
	/** The link target as written, anchor included, with its path percent-decoded. */
	readonly target: string;
}

export interface DocsLintResult {
	readonly brokenLinks: BrokenLink[];
	readonly missingTitles: string[];
}

const ROOT_DOCUMENTS: readonly string[] = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md"];
const LINK_TREES: readonly string[] = ["docs", ".planning"];

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

/**
 * Every link and image destination the parser reports, in render order. Code spans, code blocks (fenced, indented or
 * inside a block quote), HTML blocks and comments never reach these callbacks, and inline, reference, titled and
 * angle-wrapped destinations all arrive as the bare destination, so no regex has to guess where Markdown syntax ends.
 */
function destinations(text: string): string[] {
	const found: string[] = [];
	Bun.markdown.render(text, {
		link: (children, meta) => {
			found.push(meta.href);
			return children;
		},
		image: (children, meta) => {
			found.push(meta.src);
			return children;
		},
	});
	return found;
}

/** `raw` percent-decoded as a browser would before looking the file up; a malformed escape leaves it as written. */
function decodedPath(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/**
 * The relative markdown links and images in `text` that resolve to nothing, without repeats and in order. `dir` is the
 * directory of the document and `exists` answers whether a path is there. Destinations with a scheme, `#anchors` and
 * absolute paths are not checked; `?query` and `#fragment` are stripped and the path is percent-decoded before the
 * existence check. A broken target is reported as written (anchor and query included) except that its path is decoded,
 * so `my%20file.md` is reported as `my file.md`.
 */
export function brokenRelativeLinks(text: string, dir: string, exists: (path: string) => boolean): string[] {
	const broken = new Set<string>();
	for (const href of destinations(text)) {
		if (href === "" || EXTERNAL_TARGET.test(href)) continue;
		const rawPath = href.split(/[?#]/, 1)[0] ?? "";
		if (rawPath === "") continue;
		const path = decodedPath(rawPath);
		if (!exists(join(dir, path))) broken.add(path + href.slice(rawPath.length));
	}
	return [...broken];
}

/**
 * True when the parser finds no level-1 heading (ATX or setext) with visible text after an optional YAML front matter
 * block. Headings in code or HTML comments are not headings; inline HTML is not visible text.
 */
export function missingTitle(text: string): boolean {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	let body = lines;
	if (lines[0]?.trimEnd() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."));
		if (close > 0) body = lines.slice(close + 1);
	}
	const titles: string[] = [];
	Bun.markdown.render(body.join("\n"), {
		html: () => "",
		heading: (children, meta) => {
			if (meta.level === 1 && children.trim() !== "") titles.push(children);
			return children;
		},
	});
	return titles.length === 0;
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
