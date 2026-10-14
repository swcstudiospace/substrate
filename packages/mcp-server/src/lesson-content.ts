/**
 * What counts as a lesson body. Shared by the CLI and the memory gate so a
 * title-only lesson cannot be stored by skipping the CLI.
 */

const STOPWORDS: Record<string, true> = Object.fromEntries(
	[
		"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "into", "is", "it",
		"its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "when", "with", "not", "no",
	].map((word) => [word, true]),
);

const PLACEHOLDER_BODIES = new Set([
	"todo",
	"tbd",
	"n a",
	"na",
	"placeholder",
	"lorem ipsum",
	"lesson",
	"none",
	"null",
	"fixme",
	"xxx",
	"empty",
]);

/** A short sentence can still be a fact. A noun phrase with none of these is a title. */
const CLAUSE = /\b(?:is|are|was|were|has|have|had|does|did|can|cannot|do)\b/i;

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Letters and digits only, so `TODO:` and `n/a` match the placeholder list. */
function simplified(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Why `text` cannot be stored as a lesson. Null, empty, whitespace, a
 * placeholder, or a title with no clause is a failed create. A short sentence
 * (`The cache is disabled`) is a fact. A trailing period does not turn a title
 * into one.
 */
export function lessonContentIssue(text: string | null | undefined): string | null {
	if (text == null) return "lesson body is null";
	const collapsed = collapse(text);
	if (collapsed.length === 0) return "lesson body is empty";
	const plain = simplified(collapsed);
	// `.` and `TODO:` land here. Punctuation is not content, and a placeholder word
	// is not a fact just because it wears a colon or a period.
	if (plain.length === 0 || PLACEHOLDER_BODIES.has(plain)) return `lesson body is a placeholder (${collapsed})`;
	// A clause is a fact even when it is short. Checked before the word count so
	// "The cache is disabled" is kept: the stopword list would otherwise leave
	// only two words and a count would hide it from recall.
	if (CLAUSE.test(collapsed)) return null;
	const words = plain.split(" ").filter((word) => word.length > 0 && !STOPWORDS[word]);
	if (words.length < 3) return "lesson body is only a title or label and has no factual content";
	return null;
}

/** A lesson marker. `[lessonbankdigest]` and `[lessonbankoutcome]` are not lessons. */
export function isLessonHeader(text: string): boolean {
	return /^\[lessonbank\](?:\r?\n|$)/.test(text);
}

/** A `lesson:` subject. `lesson-digest:` and `lesson-outcome:` are not lessons. */
export function isLessonSubject(subject: string | null | undefined): boolean {
	return typeof subject === "string" && /^lesson:/i.test(subject.trim());
}

export function isLessonWrite(text: string, subject: string | null | undefined): boolean {
	return isLessonSubject(subject) || isLessonHeader(text);
}

/** The prose under a `[lessonbank]` header, or the whole text when there is no header. */
export function lessonProse(text: string): string {
	if (!isLessonHeader(text)) return text;
	const lines = text.split("\n");
	let index = 1;
	for (; index < lines.length; index++) {
		if ((lines[index] ?? "").trim() === "") break;
	}
	return lines.slice(index + 1).join("\n").trim();
}

/**
 * Why this write is an empty lesson, or null when it is not a lesson write or
 * the prose has a fact. A `lesson:` subject and a `[lessonbank]` body are both
 * lessons. Digests and outcomes use other subjects and are left alone.
 */
export function lessonWriteIssue(text: string, subject: string | null | undefined): string | null {
	if (!isLessonWrite(text, subject)) return null;
	return lessonContentIssue(isLessonHeader(text) ? lessonProse(text) : text);
}
