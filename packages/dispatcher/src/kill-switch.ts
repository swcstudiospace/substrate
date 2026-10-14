/**
 * Dispatcher kill switch (DISP-01).
 *
 * The env file is re-read on every call: a file change is visible on the next
 * tick without a restart. `process.env` is never consulted, so a value
 * captured at startup cannot leak past an operator edit.
 *
 * Fail-closed: dispatch runs only when SUBSTRATE_DISPATCH_DISABLED is exactly
 * `0`, `false`, or `no` (case-insensitive), matching `booleanOrNull` in
 * packages/mcp-server/src/config.ts. Absent file, absent variable, empty
 * value, `1`/`true`/`yes`, and anything unparseable all mean disabled.
 */

import { readFileSync } from "node:fs";

export const DEFAULT_DISPATCHER_ENV_FILE = "/etc/substrate/dispatcher.env";
export const DISPATCH_DISABLED_VAR = "SUBSTRATE_DISPATCH_DISABLED";

/** Values of SUBSTRATE_DISPATCH_DISABLED that mean "the switch is off, run". */
const ENABLED_TOKENS: Record<string, true> = { "0": true, "false": true, "no": true };

/** Last `NAME=value` wins; comments, blank lines, and `export ` prefixes are skipped. */
function lookupVar(source: string, name: string): string | undefined {
	let found: string | undefined;
	for (const rawLine of source.split("\n")) {
		let line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice("export ".length).trim();
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		if (line.slice(0, eq).trim() !== name) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		found = value;
	}
	return found;
}

/**
 * True when dispatch must not run. Re-reads `envFile` on every call.
 * Never throws for a missing or unreadable file: no file means disabled.
 */
export function isDispatchDisabled(envFile: string = DEFAULT_DISPATCHER_ENV_FILE): boolean {
	let source: string;
	try {
		source = readFileSync(envFile, "utf8");
	} catch {
		return true;
	}
	const raw = lookupVar(source, DISPATCH_DISABLED_VAR);
	if (raw === undefined) return true;
	const normalized = raw.trim().toLowerCase();
	if (normalized.length === 0) return true;
	return ENABLED_TOKENS[normalized] !== true;
}
