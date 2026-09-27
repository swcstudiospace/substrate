/**
 * Redaction applied to every event and memory entry before it is stored.
 *
 * Ports the patterns from grok-hermes-connector's `redactor.py` so that every
 * surface strips the same things, and adds the credential classes this
 * substrate actually handles: Linear, Notion, GitHub, xAI, Anthropic, OpenAI,
 * Railway, bearer tokens, JWTs and passworded connection URLs, and the classes
 * agentmemory's /remember does not filter (D-04).
 *
 * This runs on the write path. An event that reaches Greptime is already clean;
 * there is no second chance once it is in an append-only log.
 */

export const REDACTED = "[REDACTED]";
const REDACTED_PEM = "[REDACTED_PEM]";
const REDACTED_TSKEY = "[REDACTED_TSKEY]";

/** Ordered: broader structural patterns first, then token shapes. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
	// ── D-04 structural: a <private> block, first so a PEM inside it goes as one block ─
	[/<private>[\s\S]*?<\/private>/gi, REDACTED],
	// ── from redactor.py ──────────────────────────────────────────────────────
	[/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, REDACTED_PEM],
	[/tskey-[A-Za-z0-9_-]+/g, REDACTED_TSKEY],
	[/(password\s*[:=]\s*)(\S+)/gi, `$1${REDACTED}`],
	[/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS)\s*=\s*)(\S+)/gi, `$1${REDACTED}`],
	[/\b(DAYTONA_(?:API_)?KEY\s*=\s*)(\S+)/gi, `$1${REDACTED}`],
	[/\b((?:VAULT_TOKEN|VAULT_TOKEN_ID|X-VAULT-TOKEN)\s*[:=]\s*)(\S+)/gi, `$1${REDACTED}`],

	// ── credentials this substrate touches ────────────────────────────────────
	// Any FOO_TOKEN / FOO_KEY_BAR / FOO_SECRET assignment, incl. our own
	// SUBSTRATE_TOKEN_* where the keyword sits mid-name. The keyword must be a
	// whole underscore-delimited segment, so KEYBOARD_LAYOUT is not a secret.
	[/\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*\s*[:=]\s*)(\S+)/g, `$1${REDACTED}`],
	// D-04 api-key-lower: api_key / apiKey / api-key assignments, any case; keeps the key.
	[/\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}/gi, `$1$2${REDACTED}`],
	// Authorization headers, however cased.
	[/\b(authorization\s*[:=]\s*)(?:bearer\s+)?(\S+)/gi, `$1${REDACTED}`],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, `Bearer ${REDACTED}`],
	// Connection URLs carrying a password.
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi, `$1:${REDACTED}@`],
	// Provider token shapes.
	[/\blin_api_[A-Za-z0-9]{20,}/g, REDACTED],
	[/\blin_oauth_[A-Za-z0-9]{20,}/g, REDACTED],
	[/\b(?:ntn_|secret_)[A-Za-z0-9]{30,}/g, REDACTED],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
	[/\bxai-[A-Za-z0-9]{20,}/g, REDACTED],
	[/\bsk-ant-[A-Za-z0-9_-]{20,}/g, REDACTED],
	[/\bsk-(?!ant-)[A-Za-z0-9]{20,}/g, REDACTED],
	// ── D-04: shapes agentmemory's /remember does not filter ──────────────────
	// aws: AWS access key id.
	[/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
	// google: Google API key.
	[/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
	// slack: Slack bot token.
	[/\bxoxb-[0-9A-Za-z-]{10,}/g, REDACTED],
	// npm: npm access token.
	[/\bnpm_[A-Za-z0-9]{36}/g, REDACTED],
	// gitlab: GitLab personal access token.
	[/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
	// digitalocean: DigitalOcean personal access token.
	[/\bdop_v1_[a-f0-9]{64}/g, REDACTED],
	// openai-proj: OpenAI project key (the sk- rule above stops at its second hyphen).
	[/\bsk-proj-[A-Za-z0-9_-]{20,}/g, REDACTED],
	// pk / rk: publishable and restricted keys.
	[/\b(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, REDACTED],
	// JWTs.
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
	// Private keypair arrays, e.g. a Solana keypair pasted into a summary.
	[/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, REDACTED],
];

/** Redact a single string. Returns it unchanged when nothing matches. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
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

export function redactValue<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map(redactValue) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SENSITIVE_KEY.test(key) && inner !== null && inner !== undefined ? REDACTED : redactValue(inner);
		}
		return out as T;
	}
	return value;
}

// ── skill content (D-18) ────────────────────────────────────────────────────

/**
 * Skill files are instructions: `Authorization: Bearer $PARALLEL_API_KEY` is a working
 * line an agent has to read, which `redact()` above would destroy. Skills therefore get
 * their own pass: env references and placeholders survive, real values after the
 * contextual rules are redacted, and a high-confidence token shape is never redacted
 * silently — it is a finding the caller rejects on, unless its rule is an allowed
 * documentation example (pem, jwt). Results name the line and the rule, never the value.
 * `redact()` and `redactValue()` (the event path) are not affected.
 */
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
	rule: SkillRedactionRule;
	pattern: RegExp;
	/** Capture group holding the value that is replaced (0 = the whole match). */
	value: number;
	replacement: string;
}

/**
 * The patterns of `RULES`, labelled, plus `aws` (skills only). High-confidence shapes
 * come first so a contextual rule can never claim, and quietly redact, a real token.
 * Around a key the whitespace stays on its line (`[ \t]`, not `\s`), so a YAML
 * `password:` at a line end never takes the first word of the next line as its value.
 * The keypair-array rule has no skill counterpart: byte arrays are ordinary code in docs.
 */
const SKILL_RULES: readonly SkillRule[] = [
	{ rule: "pem", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/dg, value: 0, replacement: REDACTED_PEM },
	{ rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg, value: 0, replacement: REDACTED },
	{ rule: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "github", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "openai", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "xai", pattern: /\bxai-[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "linear", pattern: /\blin_api_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "linear", pattern: /\blin_oauth_[A-Za-z0-9]{20,}/dg, value: 0, replacement: REDACTED },
	{ rule: "notion", pattern: /\b(?:ntn_|secret_)[A-Za-z0-9]{30,}/dg, value: 0, replacement: REDACTED },
	{ rule: "tailscale", pattern: /tskey-[A-Za-z0-9_-]+/dg, value: 0, replacement: REDACTED_TSKEY },
	{ rule: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/dg, value: 0, replacement: REDACTED },
	{ rule: "password", pattern: /(password[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ rule: "password", pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PASS)[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ rule: "assignment", pattern: /\b(DAYTONA_(?:API_)?KEY[ \t]*=[ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ rule: "assignment", pattern: /\b((?:VAULT_TOKEN|VAULT_TOKEN_ID|X-VAULT-TOKEN)[ \t]*[:=][ \t]*)(\S+)/dgi, value: 2, replacement: REDACTED },
	{ rule: "assignment", pattern: /\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*[ \t]*[:=][ \t]*)(\S+)/dg, value: 2, replacement: REDACTED },
	// Before `authorization`, so a literal after "Authorization: Bearer" is reported as bearer.
	{ rule: "bearer", pattern: /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{12,}=*)/dg, value: 2, replacement: REDACTED },
	{ rule: "authorization", pattern: /\b(authorization[ \t]*[:=][ \t]*)(?:bearer[ \t]+)?(\S+)/dgi, value: 2, replacement: REDACTED },
	{ rule: "url-password", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/dgi, value: 2, replacement: REDACTED },
];

const PLACEHOLDER_PREFIXES = ["your", "xxx", "...", "***", "example", "changeme", "placeholder", "redacted"];

/**
 * Env references, `<…>` and the placeholder words; `[REDACTED…]` so a second pass is a no-op.
 * Scraped Markdown escapes underscores, so `$OPENAI\_API\_KEY` is an env reference too.
 */
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
	/** Absent when the value is a placeholder: the span is claimed but left as written. */
	replace?: { start: number; end: number; with: string };
	kind: "redaction" | "finding" | "kept";
}

/** Redact one skill file. Line numbers are 1-based, counted in the original text. */
export function redactSkillContent(
	text: string,
	opts: SkillRedactionOptions = {},
): { text: string; redactions: SkillRedactionHit[]; findings: SkillRedactionHit[] } {
	const claims: Claim[] = [];
	for (const { rule, pattern, value, replacement } of SKILL_RULES) {
		const highConfidence = SKILL_HIGH_CONFIDENCE_RULES.includes(rule);
		for (const match of text.matchAll(pattern)) {
			const whole = match.indices?.[0];
			const span = match.indices?.[value];
			const captured = match[value];
			if (!whole || !span || captured === undefined) continue;
			const [start, end] = whole;
			if (claims.some((claim) => start < claim.end && claim.start < end)) continue;
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
		if (claim.kind === "kept" || !claim.replace) continue;
		for (let i = text.indexOf("\n", counted); i !== -1 && i < claim.start; i = text.indexOf("\n", i + 1)) line++;
		counted = claim.start;
		(claim.kind === "finding" ? findings : redactions).push({ line, rule: claim.rule });
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
