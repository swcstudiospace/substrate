/**
 * Decide from a repository-relative path alone whether a file is a documentation candidate and, if so, what kind of
 * document it is and which tier it sits in (v1.7 phase 63, decision D63-5).
 *
 * Pure: no file is opened. The rules run in a fixed order and the first match wins, on the lowercased path.
 */
import { DIGEST_PATH, type DocKind, type DocTier } from "./protocol.ts";

export interface Classification {
	kind: DocKind;
	tier: DocTier;
}

export interface ClassifyContext {
	/**
	 * Whether the path sits at the root of its repository. Defaults to "the path has one segment"; a caller that
	 * classifies a path relative to a directory other than the repository root says so here.
	 */
	root?: boolean | undefined;
}

/** The extensions that make a file a documentation candidate, lowercase. */
export const DOC_EXTENSIONS = [".md", ".mdx", ".rst", ".adoc"] as const;

/** Directory names that never hold documentation worth keeping: dependencies, build output and caches. */
export const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".cache",
	"coverage",
	"site-packages",
	"third_party",
]);

/** True when `name` ends in one of the documentation extensions, case-insensitively. */
export function hasDocExtension(name: string): boolean {
	const lower = name.toLowerCase();
	return DOC_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** True when `segment` (a directory name, any case) is one the scan never enters. */
export function isExcludedSegment(segment: string): boolean {
	return EXCLUDED_SEGMENTS.has(segment.toLowerCase());
}

function planningKind(rel: string[]): Classification {
	const name = rel[rel.length - 1] ?? "";
	const first = rel[0] ?? "";
	if (rel.length === 1) {
		switch (name) {
			case "state.md":
				return { kind: "planning-state", tier: 1 };
			case "roadmap.md":
				return { kind: "planning-roadmap", tier: 1 };
			case "requirements.md":
				return { kind: "planning-requirements", tier: 1 };
			case "project.md":
				return { kind: "planning-project", tier: 1 };
			case "milestones.md":
				return { kind: "planning-milestones", tier: 1 };
			case "retrospective.md":
				return { kind: "planning-milestones", tier: 2 };
			default:
				return { kind: "planning-other", tier: 2 };
		}
	}
	if (first === "milestones") {
		return name.endsWith("milestone-audit.md")
			? { kind: "planning-audit", tier: 2 }
			: { kind: "planning-archive", tier: 3 };
	}
	if (first === "phases") {
		if (name.endsWith("-context.md")) return { kind: "planning-context", tier: 2 };
		if (name.endsWith("-summary.md")) return { kind: "planning-summary", tier: 2 };
		if (name.endsWith("-verification.md")) return { kind: "planning-verification", tier: 2 };
		if (name.endsWith("-plan.md")) return { kind: "planning-plan", tier: 3 };
		if (name.endsWith("-research.md")) return { kind: "planning-research", tier: 2 };
	}
	if (first === "research") return { kind: "planning-research", tier: 2 };
	return { kind: "planning-other", tier: 3 };
}

/**
 * Classify one repository-relative path (forward slashes). Returns null when the file is not a documentation
 * candidate: its extension is not a documentation one, or one of its directories is excluded.
 */
export function classify(path: string, ctx: ClassifyContext = {}): Classification | null {
	const segments = path
		.replace(/\\/g, "/")
		.toLowerCase()
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	const name = segments[segments.length - 1];
	if (name === undefined || !hasDocExtension(name)) return null;
	const dirs = segments.slice(0, -1);
	if (dirs.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return null;

	// The repository digest lives at one virtual path that no checkout owns; the match is exact, so a nested copy is not one.
	if (segments.join("/") === DIGEST_PATH) return { kind: "digest", tier: 1 };
	const atRoot = ctx.root ?? segments.length === 1;

	// A `.planning` directory may sit at any depth in a monorepo; the rules apply from the first one.
	const planningAt = dirs.indexOf(".planning");
	if (planningAt !== -1) return planningKind(segments.slice(planningAt + 1));

	if (name === "agents.md" || name === "claude.md") return { kind: "agents", tier: 1 };
	if (name === "skill.md") return { kind: "skill", tier: 1 };
	if (name.startsWith("changelog") || name.startsWith("history") || name.startsWith("releases")) {
		return { kind: "changelog", tier: atRoot ? 1 : 2 };
	}
	if (dirs.includes("adr") || dirs.includes("decisions")) return { kind: "adr", tier: 1 };
	if (dirs.includes("runbooks")) return { kind: "runbook", tier: 1 };
	if (dirs[0] === "docs") return { kind: "doc", tier: dirs[1] === "research" ? 2 : 1 };
	if (name.startsWith("readme")) return { kind: "readme", tier: atRoot ? 1 : 2 };
	return { kind: "other", tier: 3 };
}
