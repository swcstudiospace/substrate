/**
 * Wraps text that the model must read as data, not instructions, in a
 * delimited block. Pure: it reads no files, opens no sockets, and logs nothing.
 *
 * The block cannot be closed from inside: any `</untrusted-data` in the text
 * has its `<` replaced by `&lt;`, so the only closing tag in the output is the
 * one this function appends.
 */

export const DEFAULT_MAX_CHARS = 4000;

const TRUNCATED_MARKER = "[truncated]";

// C0 and C1 control characters, except tab (0x09) and newline (0x0a).
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing these is the purpose of the pattern
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const CLOSING_TAG_LEAD = /<(\/untrusted-data)/gi;
const ATTRIBUTE_SPECIALS = /[&<>"]/g;
const ATTRIBUTE_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

export interface WrapUntrustedOptions {
	/** Where the text came from, e.g. "linear:issue-description". Attribute-escaped. */
	source: string;
	text: string;
	/** Characters of `text` kept before the block is cut. Defaults to `DEFAULT_MAX_CHARS`. */
	maxChars?: number;
}

export function wrapUntrusted({
	source,
	text,
	maxChars = DEFAULT_MAX_CHARS,
}: WrapUntrustedOptions): string {
	let body = text.replace(CONTROL_CHARS, "");
	if (body.length > maxChars) {
		let end = maxChars;
		// Do not leave a lone high surrogate at the cut.
		const last = body.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		body = `${body.slice(0, end)}\n${TRUNCATED_MARKER}`;
	}
	body = body.replace(CLOSING_TAG_LEAD, "&lt;$1");
	const attribute = source.replace(ATTRIBUTE_SPECIALS, (ch) => ATTRIBUTE_ENTITIES[ch] ?? ch);
	return `<untrusted-data source="${attribute}">\n${body}\n</untrusted-data>`;
}
