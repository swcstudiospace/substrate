/**
 * Redaction applied to every event and memory entry before it is stored.
 *
 * Ports the patterns from grok-hermes-connector's `redactor.py` so that every
 * surface strips the same things, and adds the credential classes this
 * substrate actually handles: Linear, Notion, GitHub, xAI, Anthropic, OpenAI,
 * Railway, bearer tokens, JWTs and passworded connection URLs.
 *
 * This runs on the write path. An event that reaches Greptime is already clean;
 * there is no second chance once it is in an append-only log.
 */

export const REDACTED = "[REDACTED]";
export const REDACTED_PEM = "[REDACTED_PEM]";
const REDACTED_TSKEY = "[REDACTED_TSKEY]";

/**
 * Replace each `open ... close` block, lazily, in one left-to-right pass.
 *
 * The regex `open[\s\S]*?close` is the same match, but when no closing tag exists it
 * rescans the rest of the text from every opening one: n openings over n bytes is
 * quadratic, and the event path runs this on bodies up to 1 MB before they are capped.
 * Here a missing close ends the pass, because no later opening can have one either.
 * `open` and `close` are literal-shaped patterns searched with `exec`, so each byte is
 * visited a bounded number of times.
 */
function delimitedSpans(text: string, open: RegExp, close: RegExp): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let from = 0;
	for (;;) {
		open.lastIndex = from;
		const opening = open.exec(text);
		if (!opening) break;
		close.lastIndex = opening.index + opening[0].length;
		const closing = close.exec(text);
		if (!closing) break;
		const end = closing.index + closing[0].length;
		spans.push([opening.index, end]);
		from = end;
	}
	return spans;
}

function redactDelimited(text: string, open: RegExp, close: RegExp, replacement: string): string {
	const spans = delimitedSpans(text, open, close);
	if (spans.length === 0) return text;
	let out = "";
	let copied = 0;
	for (const [start, end] of spans) {
		out += text.slice(copied, start) + replacement;
		copied = end;
	}
	return out + text.slice(copied);
}

const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi;
const PRIVATE_OPEN = /<private>/gi;
const PRIVATE_CLOSE = /<\/private>/gi;
const PEM_OPEN = /-----BEGIN[ A-Z]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END[ A-Z]*PRIVATE KEY-----/g;

interface StructuralMark {
	start: number;
	end: number;
	with: string;
}

/**
 * Replace private blocks and PEM blocks together, measured on the original text.
 *
 * Applying them in sequence drops a delimiter the other rule still needs: a PEM
 * whose only BEGIN or END line sits inside `<private>` keeps its key body. The
 * skill pass already keeps the earlier marker and extends the copy through the
 * union; the event pass does the same.
 */
function redactStructural(text: string): string {
	const marks: StructuralMark[] = [
		...delimitedSpans(text, PRIVATE_OPEN, PRIVATE_CLOSE).map(([start, end]) => ({
			start,
			end,
			with: REDACTED,
		})),
		...delimitedSpans(text, PEM_OPEN, PEM_CLOSE).map(([start, end]) => ({
			start,
			end,
			with: REDACTED_PEM,
		})),
	];
	if (marks.length === 0) return text;
	marks.sort((a, b) => a.start - b.start || b.end - a.end);
	let out = "";
	let copied = 0;
	for (const mark of marks) {
		if (mark.end <= copied) continue;
		if (mark.start < copied) {
			copied = mark.end;
			continue;
		}
		out += text.slice(copied, mark.start) + mark.with;
		copied = mark.end;
	}
	return out + text.slice(copied);
}

/** `pk-` or `rk-` and the whole run after it; the caller decides whether the run holds a digit. */
const PK_RK_RUN = /\b(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g;

/**
 * A `pk-`/`rk-` key needs a digit in its run (D18-21). The pattern in `RULES` states that with a
 * lookahead, which rescans the whole run from every `pk-` inside it: a run of repeated `pk-` is
 * quadratic. Matching the run once and testing it for a digit is the same set of matches
 * (the run is greedy, so it is exactly what the lookahead looked at) in one pass.
 */
function redactPkRk(text: string): string {
	return text.replace(PK_RK_RUN, (run) => (/[0-9]/.test(run) ? REDACTED : run));
}

/**
 * Ordered: broader structural patterns first, then token shapes.
 *
 * `pattern` is the rule's definition and what the fixtures and the lock read. A rule with
 * `apply` is *run* through that function instead, because the pattern, applied directly,
 * is quadratic on adversarial input; `redact.test.ts` pins each `apply` to its pattern on
 * ordinary text so the two cannot drift.
 */
const RULES = [
	// ── D-04 structural: a <private> block, first so a PEM inside it goes as one block ─
	{
		name: "private-tag",
		pattern: /<private>[\s\S]*?<\/private>/gi,
		replacement: REDACTED,
		apply: (text: string) => redactDelimited(text, PRIVATE_OPEN, PRIVATE_CLOSE, REDACTED),
	},
	// ── from redactor.py ──────────────────────────────────────────────────────
	{
		name: "pem",
		pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
		replacement: REDACTED_PEM,
		apply: (text: string) => redactDelimited(text, PEM_OPEN, PEM_CLOSE, REDACTED_PEM),
	},
	{ name: "tailscale", pattern: /tskey-[A-Za-z0-9_-]+/g, replacement: REDACTED_TSKEY },
	{ name: "password", pattern: /(password\s*[:=]\s*)(\S+)/gi, replacement: `$1${REDACTED}` },
	{ name: "password-env", pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS)\s*=\s*)(\S+)/gi, replacement: `$1${REDACTED}` },
	{ name: "daytona", pattern: /\b(DAYTONA_(?:API_)?KEY\s*=\s*)(\S+)/gi, replacement: `$1${REDACTED}` },
	{ name: "vault", pattern: /\b((?:VAULT_TOKEN|VAULT_TOKEN_ID|X-VAULT-TOKEN)\s*[:=]\s*)(\S+)/gi, replacement: `$1${REDACTED}` },

	// ── credentials this substrate touches ────────────────────────────────────
	// Any FOO_TOKEN / FOO_KEY_BAR / FOO_SECRET assignment, incl. our own
	// SUBSTRATE_TOKEN_* where the keyword sits mid-name. The keyword must be a
	// whole underscore-delimited segment, so KEYBOARD_LAYOUT is not a secret.
	{ name: "assignment", pattern: /\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*\s*[:=]\s*)(\S+)/g, replacement: `$1${REDACTED}` },
	// D-04 api-key-lower: api_key / apiKey / api-key assignments, any case; keeps the key.
	// The value runs on past its charset to the end of the token (`[^\s"'`,;)]*`), so a value that
	// carries punctuation is redacted whole rather than left with a tail.
	{ name: "api-key-lower", pattern: /\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}[^\s"'`,;)]*/gi, replacement: `$1$2${REDACTED}` },
	// Authorization headers, however cased.
	{ name: "authorization", pattern: /\b(authorization\s*[:=]\s*)(?:bearer\s+)?(\S+)/gi, replacement: `$1${REDACTED}` },
	{ name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replacement: `Bearer ${REDACTED}` },
	// Connection URLs carrying a password.
	// A match needs a literal `://`, so text without one is skipped: from every word boundary the
	// scheme scan otherwise runs to the end of the run, which is quadratic on a long hyphenated run.
	{
		name: "url-password",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi,
		replacement: `$1:${REDACTED}@`,
		apply: (text: string) => (text.includes("://") ? text.replace(URL_PASSWORD, `$1:${REDACTED}@`) : text),
	},
	// Provider token shapes.
	{ name: "linear-api", pattern: /\blin_api_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	{ name: "linear-oauth", pattern: /\blin_oauth_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	{ name: "notion", pattern: /\b(?:ntn_|secret_)[A-Za-z0-9]{30,}/g, replacement: REDACTED },
	{ name: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	{ name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
	{ name: "xai", pattern: /\bxai-[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	{ name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
	{ name: "openai", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	// ── D-04: shapes agentmemory's /remember does not filter ──────────────────
	// aws: AWS access key id.
	{ name: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
	// google: Google API key.
	{ name: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replacement: REDACTED },
	// slack: Slack bot token.
	{ name: "slack", pattern: /\bxoxb-[0-9A-Za-z-]{10,}/g, replacement: REDACTED },
	// npm: npm access token.
	{ name: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}/g, replacement: REDACTED },
	// gitlab: GitLab personal access token.
	{ name: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
	// digitalocean: DigitalOcean personal access token.
	{ name: "digitalocean", pattern: /\bdop_v1_[a-f0-9]{64}/g, replacement: REDACTED },
	// openai-proj: OpenAI project key (the sk- rule above stops at its second hyphen).
	{ name: "openai-proj", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
	// ragflow: RAGFlow API key (D25-23). High-confidence on both passes, so a
	// key pasted into a doc page is refused, never uploaded.
	{ name: "ragflow", pattern: /\bragflow-[A-Za-z0-9]{20,}/g, replacement: REDACTED },
	// pk / rk: publishable and restricted keys. D18-21 narrowed: the matched tail
	// must contain at least one digit, so word-only slugs are not secrets.
	{
		name: "pk-rk",
		pattern: /\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
		replacement: REDACTED,
		apply: redactPkRk,
	},
	// JWTs.
	{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
	// Private keypair arrays, e.g. a Solana keypair pasted into a summary.
	{ name: "keypair-array", pattern: /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, replacement: REDACTED },
] as const satisfies ReadonlyArray<{ name: string; pattern: RegExp; replacement: string; apply?: (text: string) => string }>;

export type RedactionRuleName = (typeof RULES)[number]["name"];

/** Read-only view for tests and docs. `redact()` is the only thing that applies it. */
export const REDACTION_RULES: ReadonlyArray<{ readonly name: RedactionRuleName; readonly pattern: RegExp; readonly replacement: string }> = RULES;

/** Redact a single string. Returns it unchanged when nothing matches. */
export function redact(text: string): string {
	let out = redactStructural(text);
	for (const rule of RULES) {
		// private-tag and pem already ran together on the original text.
		if (rule.name === "private-tag" || rule.name === "pem") continue;
		out = "apply" in rule ? rule.apply(out) : out.replace(rule.pattern, rule.replacement);
	}
	return out;
}

/**
 * Each rule's own `apply`, or the plain pattern replace.
 *
 * Parity tests compare this with the pattern on ordinary text. `redact()` runs
 * `private-tag` and `pem` together on the original text instead of through this.
 */
export function applyRule(name: RedactionRuleName, text: string): string {
	const rule = RULES.find((entry) => entry.name === name);
	if (!rule) throw new Error(`no redaction rule ${name}`);
	return "apply" in rule ? rule.apply(text) : text.replace(rule.pattern, rule.replacement);
}

/**
 * Redact recursively through a JSON-shaped value.
 *
 * Object keys that name a credential are redacted whole rather than
 * pattern-matched, because a bare token value has no surrounding context for
 * the rules above to anchor on.
 */
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)/i;

/**
 * Keys that contain a credential word but name a **count**, not a credential.
 *
 * `input_tokens` is how much a model was billed for. The rule above matched the
 * substring `token` and replaced the number with `[REDACTED]`, so every token count
 * any collector reported was destroyed on the write path — invisible, because a
 * redacted field looks like redaction working. That is what this exists to stop, and
 * it is why the token and cost metrics need it: `extractUsage` reads these keys.
 *
 * Narrow on purpose. The exemption applies only to these exact names **and only when
 * the value is a count** — a finite number, or a string of digits — so
 * `{"tokens": "sk-ant-…"}` is still redacted whole.
 */
const COUNTER_KEY =
	/^(?:(?:input|output|prompt|completion|total|cached|cache_read|cache_write|max|min|reasoning)_)?tokens?(?:_(?:count|in|out|used))?$/i;

/**
 * Whether a value under a counter key is actually a count.
 *
 * A number, or a string of digits. The string form matters because `extractUsage`
 * accepts `"1200"` — several collectors ship their counts as strings — and a redactor
 * that only exempted numbers would blank exactly those, so the two would disagree and
 * the usage would be lost on the write path. A purely numeric string carries no
 * credential shape, and anything else under the key is still redacted whole.
 */
function isCount(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
}

export function redactValue<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map(redactValue) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			const sensitive =
				SENSITIVE_KEY.test(key) && !(COUNTER_KEY.test(key) && isCount(inner)) && inner !== null && inner !== undefined;
			out[key] = sensitive ? REDACTED : redactValue(inner);
		}
		return out as T;
	}
	return value;
}
/** The markers this module itself writes. Only these exact spans are left alone by `redactKnown`. */
const EMITTED_MARKER = /(\[REDACTED(?:_PEM|_TSKEY)?\])/;

/**
 * Scrub caller-known values (a token, a URL component) out of a diagnostic string.
 *
 * Every occurrence of every value is found in the original text, **including overlapping
 * ones**, and the union of those spans is replaced: a short value that begins inside a
 * longer secret (`CAN` in front of `CANARYtoken`) cannot consume the start of it and leave
 * the rest behind. An empty value is ignored, because replacing it would splice the marker
 * between every character. Only the markers this module itself writes (`[REDACTED]`,
 * `[REDACTED_PEM]`, `[REDACTED_TSKEY]`) are skipped, so a value that is a substring of one
 * (`RED`, `E`) neither splices markers into markers nor breaks idempotence. Anything else that
 * merely looks like a marker, such as `[REDACTED_OPAQUE]` echoed back by a server, is
 * scrubbed like any other text: a marker-shaped span is not evidence that nothing is inside.
 *
 * The caller still runs the result through `redact()`, for shapes this list cannot name.
 */
export function redactKnown(text: string, values: Iterable<string>): string {
	const needles = [...new Set(values)].filter((value) => value.length > 0);
	if (needles.length === 0) return text;
	return text
		.split(EMITTED_MARKER)
		.map((segment, index) => (index % 2 === 1 ? segment : scrubSegment(segment, needles)))
		.join("");
}

function scrubSegment(segment: string, needles: readonly string[]): string {
	const spans: Array<[number, number]> = [];
	for (const needle of needles) {
		// `from + 1`, not `from + needle.length`: an overlapping occurrence still counts.
		for (let at = segment.indexOf(needle); at !== -1; at = segment.indexOf(needle, at + 1)) {
			spans.push([at, at + needle.length]);
		}
	}
	if (spans.length === 0) return segment;
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let out = "";
	let copied = 0;
	let [start, end] = spans[0] as [number, number];
	const flush = () => {
		out += segment.slice(copied, start) + REDACTED;
		copied = end;
	};
	for (const [from, to] of spans.slice(1)) {
		if (from < end) end = Math.max(end, to);
		else {
			flush();
			[start, end] = [from, to];
		}
	}
	flush();
	return out + segment.slice(copied);
}
// ── skill content (D-18) ────────────────────────────────────────────────────
// Skill files are instructions: `Authorization: Bearer $PARALLEL_API_KEY` is a
// working line an agent has to read, which `redact()` above would destroy.
// Skills therefore get their own pass: env references and placeholders survive,
// real values after the contextual rules are redacted, and a high-confidence
// token shape is never redacted silently — it is a finding the caller rejects
// on, unless its rule is an allowed documentation example (pem, jwt). Results
// name the line and the rule, never the value. `redact()` and `redactValue()`
// (the event path) are not affected.
export type SkillRedactionRule =
	| "pem"
	| "jwt"
	| "github"
	| "openai"
	| "anthropic"
	| "xai"
	| "linear"
	| "notion"
	| "tailscale"
	| "aws"
	| "google"
	| "slack"
	| "npm"
	| "gitlab"
	| "digitalocean"
	| "openai-proj"
	| "ragflow"
	| "private-tag"
	| "pk-rk"
	| "api-key-lower"
	| "assignment"
	| "authorization"
	| "bearer"
	| "url-password"
	| "password";
export const SKILL_HIGH_CONFIDENCE_RULES: readonly SkillRedactionRule[] = [
	"pem",
	"jwt",
	"github",
	"openai",
	"anthropic",
	"xai",
	"linear",
	"notion",
	"tailscale",
	"aws",
	"google",
	"slack",
	"npm",
	"gitlab",
	"digitalocean",
	"openai-proj",
	"ragflow",
];
/** The only high-confidence rules a caller may downgrade from finding to redaction. */
export type SkillDocExampleRule = "pem" | "jwt";
export interface SkillRedactionOptions {
	allowDocExamples?: ReadonlySet<SkillDocExampleRule>;
}
export interface SkillRedactionHit {
	line: number;
	rule: SkillRedactionRule;
}
export interface SkillFileHit extends SkillRedactionHit {
	file: string;
}
interface SkillRule {
	/** The event-path rule this entry mirrors; the parity test compares these. */
	name: RedactionRuleName;
	/** What a hit reports. A family: both GitHub shapes report `github`. */
	rule: SkillRedactionRule;
	pattern: RegExp;
	/** Capture group holding the value that is replaced (0 = the whole match). */
	value: number;
	replacement: string;
	/**
	 * A match the pattern finds is a hit only if this accepts its text. `pk-rk` uses it for the digit
	 * the matched run must hold, so the pattern needs no lookahead that rescans the run (quadratic).
	 */
	accept?: (matched: string) => boolean;
	/**
	 * Delimited blocks (`<private>…</private>`, a PEM) are found by a single left-to-right scan
	 * instead of `pattern`, which is quadratic when the closing delimiter is missing. The result is
	 * the same spans the lazy pattern would match.
	 */
	scan?: (text: string) => Array<[number, number]>;
	/**
	 * Skip the rule when this is false. `url-password` only matches a URL, so a
	 * file with no `://` must not pay for the capture scan.
	 */
	gate?: (text: string) => boolean;
}
// The patterns of `RULES`, labelled, plus the D-04 skill entries (D18-08).
// High-confidence shapes come first so a contextual rule can never claim, and
// quietly redact, a real token. Around a key the whitespace stays on its line
// (`[ \t]`, not `\s`), so a YAML `password:` at a line end never takes the first
// word of the next line as its value. The keypair-array rule has no skill
// counterpart: byte arrays are ordinary code in docs.
const SKILL_RULES: readonly SkillRule[] = [
	{
		name: "pem",
		rule: "pem",
		pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/dg,
		value: 0,
		replacement: REDACTED_PEM,
		scan: (text) => delimitedSpans(text, PEM_OPEN, PEM_CLOSE),
	},
	{ name: "jwt", rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg, value: 0, replacement: REDACTED },
	{ name: "github", rule: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "github-pat", rule: "github", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "anthropic", rule: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "openai", rule: "openai", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "xai", rule: "xai", pattern: /\bxai-[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "linear-api", rule: "linear", pattern: /\blin_api_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "linear-oauth", rule: "linear", pattern: /\blin_oauth_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "notion", rule: "notion", pattern: /\b(?:ntn_|secret_)[A-Za-z0-9]{30,}/dg, value: 0, replacement: REDACTED },
	{ name: "tailscale", rule: "tailscale", pattern: /tskey-[A-Za-z0-9_-]+/dg, value: 0, replacement: REDACTED_TSKEY },
	{ name: "aws", rule: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/dg, value: 0, replacement: REDACTED },
	{ name: "google", rule: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}/dg, value: 0, replacement: REDACTED },
	{ name: "slack", rule: "slack", pattern: /\bxoxb-[0-9A-Za-z-]{10,}/dg, value: 0, replacement: REDACTED },
	{ name: "npm", rule: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}/dg, value: 0, replacement: REDACTED },
	{ name: "gitlab", rule: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "digitalocean", rule: "digitalocean", pattern: /\bdop_v1_[a-f0-9]{64}/dg, value: 0, replacement: REDACTED },
	{ name: "openai-proj", rule: "openai-proj", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
	{ name: "ragflow", rule: "ragflow", pattern: /\bragflow-[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{
		name: "private-tag",
		rule: "private-tag",
		pattern: /<private>[\s\S]*?<\/private>/dgi,
		value: 0,
		replacement: REDACTED,
		scan: (text) => delimitedSpans(text, PRIVATE_OPEN, PRIVATE_CLOSE),
	},
	// pk / rk: D18-21 narrowed — the matched tail must contain at least one digit,
	// so word-only slugs are not findings. Skill pass keeps its `dg` flags.
	{
		name: "pk-rk",
		rule: "pk-rk",
		pattern: /\b(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{19,}/dg,
		value: 0,
		replacement: REDACTED,
		accept: (matched) => /[0-9]/.test(matched),
	},
	{ name: "password", rule: "password", pattern: /(password[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "password-env", rule: "password", pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS)[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "daytona", rule: "assignment", pattern: /\b(DAYTONA_(?:API_)?KEY[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "vault", rule: "assignment", pattern: /\b((?:VAULT_TOKEN|VAULT_TOKEN_ID|X-VAULT-TOKEN)[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "assignment", rule: "assignment", pattern: /\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*[ \t]*[:=][ \t]*)(\S+)/dg, value: 2, replacement: REDACTED },
	{ name: "api-key-lower", rule: "api-key-lower", pattern: /\b(api[_-]?key)([ \t]*[:=][ \t]*["']?)([A-Za-z0-9_\-/.+]{16,}[^\s"'`,;)]*)/dgi, value: 3, replacement: REDACTED },
	// Before `authorization`, so a literal after "Authorization: Bearer" is reported as bearer.
	{ name: "bearer", rule: "bearer", pattern: /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{12,}=*)/dg, value: 2, replacement: REDACTED },
	{ name: "authorization", rule: "authorization", pattern: /\b(authorization[ \t]*[:=][ \t]*)(?:bearer[ \t]+)?(\S+)/dgi, value: 2, replacement: REDACTED },
	{
		name: "url-password",
		rule: "url-password",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/dgi,
		value: 2,
		replacement: REDACTED,
		gate: (text) => text.includes("://"),
	},
];
/** Event rules with no skill counterpart, and why. */
export const SKILL_EXCLUSIONS: Partial<Record<RedactionRuleName, string>> = {
	"keypair-array": "byte arrays are ordinary code in docs",
};
/** Read-only view of the skill entry names for the parity test and docs. */
export const SKILL_RULE_NAMES: ReadonlyArray<RedactionRuleName> = SKILL_RULES.map((entry) => entry.name);
// A whole-value placeholder shape, never a prefix test: a placeholder word with
// only `-key`/`-here`-style segments after it, or a run of x/*/. — so
// `your-api-key-goes-here` is kept while `YourDogRex2024!` still redacts (WR-02).
//
// Each unit is `[separator] [api|access] final`, and every word has exactly one place it can
// match, so a value that fails at its last character is rejected without retrying the other
// parses (`secret` used to be both a qualifier and a final word, which made a failing run of
// n `secret`s try on the order of Fibonacci(n) ways). Same language as before: a qualifier
// `secret` followed by a final word is just two final words with an optional separator.
const PLACEHOLDER_VALUE =
	/^(?:your|example|changeme|placeholder|redacted)(?:[-_ ]?(?:(?:api|access)[-_ ]?)?(?:key|token|password|value|here|goes|secret))*$|^(?:x{3,}|\*{3,}|\.{3,})$/i;

const QUOTE_OR_CLOSER = "\"'`,;)";

/** `value` without leading quotes and without trailing quotes or closers, trimmed by index (a `+$` regex is quadratic). */
function trimQuotes(value: string): string {
	let start = 0;
	while (start < value.length && "\"'`".includes(value[start] as string)) start++;
	let end = value.length;
	while (end > start && QUOTE_OR_CLOSER.includes(value[end - 1] as string)) end--;
	return value.slice(start, end);
}

// Env references, `<…>` and the placeholder shapes; `[REDACTED…]` so a second
// pass is a no-op. Scraped Markdown escapes underscores, so `$OPENAI\_API\_KEY`
// is an env reference too. The argument is the **whole assigned value**: a rule whose capture
// stops early would otherwise keep `yoursecretpassword!2024` because its first 18 characters
// look like a placeholder.
function isPlaceholder(captured: string): boolean {
	const value = trimQuotes(captured);
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value.replaceAll("\\_", "_"))) return true;
	if (/^<[^>]*>$/.test(value)) return true;
	if (/^\[REDACTED[A-Z_]*\]$/.test(value)) return true;
	return PLACEHOLDER_VALUE.test(value);
}

interface Claim {
	start: number;
	end: number;
	rule: SkillRedactionRule;
	/** Absent for kept placeholders and for finding-only hits inside a private block. */
	replace?: { start: number; end: number; with: string };
	kind: "redaction" | "finding" | "kept";
}

interface Occupied {
	start: number;
	end: number;
	rule: SkillRedactionRule;
}

/** The first range in `ranges` (sorted, disjoint) that ends after `at`. */
function firstEndingAfter(ranges: readonly Occupied[], at: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((ranges[mid] as Occupied).end <= at) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Two sorted, disjoint lists merged into one. */
function mergeSorted(a: readonly Occupied[], b: readonly Occupied[]): Occupied[] {
	const out: Occupied[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const next = j >= b.length || (i < a.length && (a[i] as Occupied).start <= (b[j] as Occupied).start) ? a[i++] : b[j++];
		out.push(next as Occupied);
	}
	return out;
}

/** Redact one skill file. Line numbers are 1-based, counted in the original text. */
export function redactSkillContent(
	text: string,
	opts: SkillRedactionOptions = {},
): { text: string; redactions: SkillRedactionHit[]; findings: SkillRedactionHit[] } {
	const claims: Claim[] = [];
	// Ranges already claimed, sorted and disjoint, so a new match is checked against them by
	// binary search instead of against every earlier claim (a file of 60 000 safe placeholders
	// made that search take seconds).
	let occupied: Occupied[] = [];
	// `<private>` blocks own their whole span: claim them before any inner
	// shape can, so block prose never survives beside an inner hit (WR-01).
	const privateEntry = SKILL_RULES.find((entry) => entry.rule === "private-tag")!;
	for (const [start, end] of privateEntry.scan?.(text) ?? []) {
		claims.push({ start, end, rule: "private-tag", replace: { start, end, with: privateEntry.replacement }, kind: "redaction" });
		occupied.push({ start, end, rule: "private-tag" });
	}
	for (const entry of SKILL_RULES) {
		const { rule, pattern, value, replacement } = entry;
		if (rule === "private-tag") continue;
		if (entry.gate && !entry.gate(text)) continue;
		const highConfidence = SKILL_HIGH_CONFIDENCE_RULES.includes(rule);
		const allowed = (rule === "pem" || rule === "jwt") && opts.allowDocExamples?.has(rule) === true;
		const found: Array<{ whole: [number, number]; span: [number, number]; captured: string }> = [];
		if (entry.scan) {
			for (const [start, end] of entry.scan(text)) found.push({ whole: [start, end], span: [start, end], captured: text.slice(start, end) });
		} else {
			for (const match of text.matchAll(pattern)) {
				const whole = match.indices?.[0];
				const span = match.indices?.[value];
				const captured = match[value];
				if (!whole || !span || captured === undefined) continue;
				if (entry.accept && !entry.accept(match[0])) continue;
				found.push({ whole: [whole[0], whole[1]], span: [span[0], span[1]], captured });
			}
		}
		const accepted: Occupied[] = [];
		let cursor = 0;
		for (const { whole: [start, end], span, captured } of found) {
			cursor = firstEndingAfter(occupied, start);
			if (cursor < occupied.length && (occupied[cursor] as Occupied).start < end) {
				// Overlaps an earlier claim. A high-confidence shape that touches a private block is
				// still reported, however it sits against the block's edges (WR-01): fully inside, the
				// block's own redaction removes it; crossing an edge, it is replaced together with the
				// block, as one span. Contextual shapes yield to whatever claimed the text first.
				let touchesPrivate = false;
				let insidePrivate = false;
				for (let k = cursor; k < occupied.length && (occupied[k] as Occupied).start < end; k++) {
					const other = occupied[k] as Occupied;
					if (other.rule !== "private-tag") continue;
					touchesPrivate = true;
					if (other.start <= start && end <= other.end) insidePrivate = true;
				}
				if (highConfidence && touchesPrivate) {
					if (insidePrivate) {
						// An allowed doc example needs no extra hit; the block covers it.
						if (!allowed) claims.push({ start, end, rule, kind: "finding" });
					} else {
						claims.push({ start, end, rule, replace: { start, end, with: replacement }, kind: allowed ? "redaction" : "finding" });
					}
				}
				continue;
			}
			if (!highConfidence && isPlaceholder(captured)) {
				claims.push({ start, end, rule, kind: "kept" });
				accepted.push({ start, end, rule });
				continue;
			}
			claims.push({
				start,
				end,
				rule,
				replace: { start: span[0], end: span[1], with: replacement },
				kind: highConfidence && !allowed ? "finding" : "redaction",
			});
			accepted.push({ start, end, rule });
		}
		if (accepted.length > 0) occupied = mergeSorted(occupied, accepted);
	}
	claims.sort((a, b) => a.start - b.start);
	const redactions: SkillRedactionHit[] = [];
	const findings: SkillRedactionHit[] = [];
	let out = "";
	let copied = 0;
	let line = 1;
	let newlineAt = text.indexOf("\n");
	for (const claim of claims) {
		if (claim.kind === "kept") continue;
		while (newlineAt !== -1 && newlineAt < claim.start) {
			line++;
			newlineAt = text.indexOf("\n", newlineAt + 1);
		}
		(claim.kind === "finding" ? findings : redactions).push({ line, rule: claim.rule });
		if (!claim.replace) continue;
		if (claim.replace.start < copied) {
			// It overlaps the span just replaced (a match that crosses a private block's edge): the
			// earlier marker already stands for the union, so only the copy position moves.
			copied = Math.max(copied, claim.replace.end);
			continue;
		}
		out += text.slice(copied, claim.replace.start) + claim.replace.with;
		copied = claim.replace.end;
	}
	return { text: out + text.slice(copied), redactions, findings };
}

/** Redact a skill's files (relative path → text); every hit names its file. */
export function scanSkillFiles(
	files: Record<string, string>,
	opts: SkillRedactionOptions = {},
): { files: Record<string, string>; redactions: SkillFileHit[]; findings: SkillFileHit[] } {
	// No prototype, so a file named `__proto__` is an entry like any other instead of vanishing.
	const out: Record<string, string> = Object.create(null) as Record<string, string>;
	const redactions: SkillFileHit[] = [];
	const findings: SkillFileHit[] = [];
	for (const [file, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const result = redactSkillContent(text, opts);
		Object.defineProperty(out, file, { value: result.text, enumerable: true, writable: true, configurable: true });
		for (const hit of result.redactions) redactions.push({ file, ...hit });
		for (const hit of result.findings) findings.push({ file, ...hit });
	}
	return { files: out, redactions, findings };
}
