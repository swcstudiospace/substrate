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
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
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
