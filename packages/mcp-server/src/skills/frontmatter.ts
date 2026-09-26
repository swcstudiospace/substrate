/**
 * SKILL.md frontmatter: a leading `---` fence, YAML, a closing `---` line. Parsed with
 * Bun.YAML (no dependency). Anything else — no fence, no closing fence, YAML that does not
 * parse or that is not a mapping — is null, and the proposal is refused on it.
 */

const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Record<string, unknown> | null {
	const match = FENCE_RE.exec(text);
	if (!match) return null;
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(match[1] ?? "");
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}
