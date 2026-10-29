/**
 * Text that came from the server (a directive body, a session id, an error message) can carry control characters from an
 * agent's output or from a proxy's error page. Every such string goes through `plain` before it reaches a terminal or a
 * model's context.
 */

/** One line, no control characters, at most `max` characters. */
export function plain(text: string, max: number): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : char;
	}
	const collapsed = out.replace(/ {2,}/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}
