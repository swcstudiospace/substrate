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
