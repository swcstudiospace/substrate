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
const REDACTED_PEM = "[REDACTED_PEM]";
const REDACTED_TSKEY = "[REDACTED_TSKEY]";

/** Ordered: broader structural patterns first, then token shapes. */
const RULES = [
	// ── D-04 structural: a <private> block, first so a PEM inside it goes as one block ─
	{ name: "private-tag", pattern: /<private>[\s\S]*?<\/private>/gi, replacement: REDACTED },
	// ── from redactor.py ──────────────────────────────────────────────────────
	{ name: "pem", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replacement: REDACTED_PEM },
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
	{ name: "api-key-lower", pattern: /\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}/gi, replacement: `$1$2${REDACTED}` },
	// Authorization headers, however cased.
	{ name: "authorization", pattern: /\b(authorization\s*[:=]\s*)(?:bearer\s+)?(\S+)/gi, replacement: `$1${REDACTED}` },
	{ name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replacement: `Bearer ${REDACTED}` },
	// Connection URLs carrying a password.
	{ name: "url-password", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi, replacement: `$1:${REDACTED}@` },
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
	// pk / rk: publishable and restricted keys. D18-21 narrowed: the matched tail
	// must contain at least one digit, so word-only slugs are not secrets.
	{ name: "pk-rk", pattern: /\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, replacement: REDACTED },
	// JWTs.
	{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
	// Private keypair arrays, e.g. a Solana keypair pasted into a summary.
	{ name: "keypair-array", pattern: /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, replacement: REDACTED },
] as const satisfies ReadonlyArray<{ name: string; pattern: RegExp; replacement: string }>;

export type RedactionRuleName = (typeof RULES)[number]["name"];

/** Read-only view for tests and docs. `redact()` is the only thing that applies it. */
export const REDACTION_RULES: ReadonlyArray<{ readonly name: RedactionRuleName; readonly pattern: RegExp; readonly replacement: string }> = RULES;

/** Redact a single string. Returns it unchanged when nothing matches. */
export function redact(text: string): string {
	let out = text;
	for (const { pattern, replacement } of RULES) out = out.replace(pattern, replacement);
	return out;
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
/**
 * Scrub caller-known values (a token, a URL component) out of a diagnostic string.
 *
 * Longest value first, so a query string never survives as the tail of a longer
 * secret replaced short-first; an empty value ignored, because replacing it would
 * splice the marker between every character. The caller still runs the result
 * through `redact()`, for shapes this list cannot name.
 */
export function redactKnown(text: string, values: Iterable<string>): string {
	const needles = [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
	let out = text;
	for (const needle of needles) out = out.replaceAll(needle, REDACTED);
	return out;
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
}
// The patterns of `RULES`, labelled, plus the D-04 skill entries (D18-08).
// High-confidence shapes come first so a contextual rule can never claim, and
// quietly redact, a real token. Around a key the whitespace stays on its line
// (`[ \t]`, not `\s`), so a YAML `password:` at a line end never takes the first
// word of the next line as its value. The keypair-array rule has no skill
// counterpart: byte arrays are ordinary code in docs.
const SKILL_RULES: readonly SkillRule[] = [
	{ name: "pem", rule: "pem", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/dg, value: 0, replacement: REDACTED_PEM },
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
	{ name: "private-tag", rule: "private-tag", pattern: /<private>[\s\S]*?<\/private>/dgi, value: 0, replacement: REDACTED },
	// pk / rk: D18-21 narrowed — the matched tail must contain at least one digit,
	// so word-only slugs are not findings. Skill pass keeps its `dg` flags.
	{ name: "pk-rk", rule: "pk-rk", pattern: /\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/dg, value: 0, replacement: REDACTED },
	{ name: "password", rule: "password", pattern: /(password[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "password-env", rule: "password", pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS)[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "daytona", rule: "assignment", pattern: /\b(DAYTONA_(?:API_)?KEY[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "vault", rule: "assignment", pattern: /\b((?:VAULT_TOKEN|VAULT_TOKEN_ID|X-VAULT-TOKEN)[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "assignment", rule: "assignment", pattern: /\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*[ \t]*[:=][ \t]*)(\S+)/dg, value: 2, replacement: REDACTED },
	{ name: "api-key-lower", rule: "api-key-lower", pattern: /\b(api[_-]?key)([ \t]*[:=][ \t]*["']?)([A-Za-z0-9_\-/.+]{16,})/dgi, value: 3, replacement: REDACTED },
	// Before `authorization`, so a literal after "Authorization: Bearer" is reported as bearer.
	{ name: "bearer", rule: "bearer", pattern: /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{12,}=*)/dg, value: 2, replacement: REDACTED },
	{ name: "authorization", rule: "authorization", pattern: /\b(authorization[ \t]*[:=][ \t]*)(?:bearer[ \t]+)?(\S+)/dgi, value: 2, replacement: REDACTED },
	{ name: "url-password", rule: "url-password", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/dgi, value: 2, replacement: REDACTED },
];
/** Event rules with no skill counterpart, and why. */
export const SKILL_EXCLUSIONS: Partial<Record<RedactionRuleName, string>> = {
	"keypair-array": "byte arrays are ordinary code in docs",
};
/** Read-only view of the skill entry names for the parity test and docs. */
export const SKILL_RULE_NAMES: ReadonlyArray<RedactionRuleName> = SKILL_RULES.map((entry) => entry.name);
const PLACEHOLDER_PREFIXES = ["your", "xxx", "...", "***", "example", "changeme", "placeholder", "redacted"];
// Env references, `<…>` and the placeholder words; `[REDACTED…]` so a second
// pass is a no-op. Scraped Markdown escapes underscores, so `$OPENAI\_API\_KEY`
// is an env reference too.
function isPlaceholder(captured: string): boolean {
	const value = captured.replace(/^["'`]+/, "").replace(/["'`,;)]+$/, "");
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value.replaceAll("\\_", "_"))) return true;
	if (/^<[^>]*>$/.test(value)) return true;
	if (/^\[REDACTED[A-Z_]*\]$/.test(value)) return true;
	const lower = value.toLowerCase();
	return PLACEHOLDER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
interface Claim {
	start: number;
	end: number;
	rule: SkillRedactionRule;
	/** Absent for kept placeholders and for finding-only hits inside a private block. */
	replace?: { start: number; end: number; with: string };
	kind: "redaction" | "finding" | "kept";
}
/** Redact one skill file. Line numbers are 1-based, counted in the original text. */
export function redactSkillContent(
	text: string,
	opts: SkillRedactionOptions = {},
): { text: string; redactions: SkillRedactionHit[]; findings: SkillRedactionHit[] } {
	const claims: Claim[] = [];
	// `<private>` blocks own their whole span: claim them before any inner
	// shape can, so block prose never survives beside an inner hit (WR-01).
	const privateEntry = SKILL_RULES.find((entry) => entry.rule === "private-tag")!;
	const privateSpans: Array<{ start: number; end: number }> = [];
	for (const match of text.matchAll(privateEntry.pattern)) {
		const whole = match.indices?.[0];
		if (!whole) continue;
		const [start, end] = whole;
		if (privateSpans.some((span) => start < span.end && span.start < end)) continue;
		privateSpans.push({ start, end });
		claims.push({ start, end, rule: "private-tag", replace: { start, end, with: privateEntry.replacement }, kind: "redaction" });
	}
	for (const { rule, pattern, value, replacement } of SKILL_RULES) {
		if (rule === "private-tag") continue;
		const highConfidence = SKILL_HIGH_CONFIDENCE_RULES.includes(rule);
		for (const match of text.matchAll(pattern)) {
			const whole = match.indices?.[0];
			const span = match.indices?.[value];
			const captured = match[value];
			if (!whole || !span || captured === undefined) continue;
			const [start, end] = whole;
			if (claims.some((claim) => start < claim.end && claim.start < end)) {
				// A high-confidence shape fully inside a private block is still
				// reported, as a finding with no replacement of its own: the
				// block redaction already removes it (WR-01). An allowed doc
				// example needs no extra hit; the block covers it.
				if (highConfidence && privateSpans.some((span) => span.start <= start && end <= span.end)) {
					const allowed = (rule === "pem" || rule === "jwt") && opts.allowDocExamples?.has(rule) === true;
					if (!allowed) claims.push({ start, end, rule, kind: "finding" });
				}
				continue;
			}
			if (!highConfidence && isPlaceholder(captured)) {
				claims.push({ start, end, rule, kind: "kept" });
				continue;
			}
			const allowed = (rule === "pem" || rule === "jwt") && opts.allowDocExamples?.has(rule) === true;
			claims.push({
				start,
				end,
				rule,
				replace: { start: span[0], end: span[1], with: replacement },
				kind: highConfidence && !allowed ? "finding" : "redaction",
			});
		}
	}
	claims.sort((a, b) => a.start - b.start);
	const redactions: SkillRedactionHit[] = [];
	const findings: SkillRedactionHit[] = [];
	let out = "";
	let copied = 0;
	let line = 1;
	let counted = 0;
	for (const claim of claims) {
		if (claim.kind === "kept") continue;
		for (let i = text.indexOf("\n", counted); i !== -1 && i < claim.start; i = text.indexOf("\n", i + 1)) line++;
		counted = claim.start;
		(claim.kind === "finding" ? findings : redactions).push({ line, rule: claim.rule });
		if (!claim.replace) continue;
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
	const out: Record<string, string> = {};
	const redactions: SkillFileHit[] = [];
	const findings: SkillFileHit[] = [];
	for (const [file, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const result = redactSkillContent(text, opts);
		out[file] = result.text;
		for (const hit of result.redactions) redactions.push({ file, ...hit });
		for (const hit of result.findings) findings.push({ file, ...hit });
	}
	return { files: out, redactions, findings };
}
