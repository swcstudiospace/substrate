const SAFE_LABEL_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** A stderr-safe label for a failure: its short code when it has one, else its constructor name. */
export function errorLabel(cause: unknown): string {
	const code = (cause as { code?: unknown } | null | undefined)?.code;
	if (typeof code === "string" && SAFE_LABEL_RE.test(code)) return code;
	const name = cause instanceof Error ? cause.constructor.name : typeof cause;
	return SAFE_LABEL_RE.test(name) ? name : "unknown";
}
