/**
 * One stderr line for a failure the server deliberately carries on past. A catch that drops a rejection
 * (an emit, a write, a bump) would otherwise leave no trace; this names the site and a code, once per site
 * per process, and never the error's message, which can carry a payload, a URL or a credential.
 */

const CODE_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

/** Sites already reported in this process. A repeat at the same site is silent. */
const reported = new Set<string>();

/**
 * The code a failure is named by: `error.code` when it is a short identifier, otherwise the error's constructor name, or
 * its `typeof` when it is not an object. A `null` is named `null`, since `typeof null` would read as an object.
 */
function codeOf(error: unknown): string {
	if (error === null) return "null";
	if (typeof error !== "object") return typeof error;
	if ("code" in error) {
		const code: unknown = error.code;
		if (typeof code === "string" && CODE_PATTERN.test(code)) return code;
	}
	const ctor: unknown = error.constructor;
	if (typeof ctor === "function" && CODE_PATTERN.test(ctor.name)) return ctor.name;
	return "object";
}

/** Write `[substrate] <site> failed (<code>)` to stderr the first time `site` fails in this process. */
export function reportSilent(site: string, error: unknown): void {
	if (reported.has(site)) return;
	reported.add(site);
	process.stderr.write(`[substrate] ${site} failed (${codeOf(error)})\n`);
}

/** Forget which sites were reported. For tests only; production never resets the set. */
export function resetSilentFailures(): void {
	reported.clear();
}
