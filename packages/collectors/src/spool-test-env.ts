/**
 * Environment isolation for the event-spool tests: every variable that changes what the spool, the refused
 * journal or the bearer resolver does is snapshotted, cleared and restored, so an operator's shell (a
 * `SUBSTRATE_EVENT_SPOOL_TTL_H=24`, an `SUBSTRATE_EVENT_SPOOL=on`, a token file) cannot change a test's answer.
 * Imported by tests only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPOOL_TEST_ENV_KEYS = [
	"SUBSTRATE_EVENT_SPOOL",
	"SUBSTRATE_EVENT_SPOOL_MAX",
	"SUBSTRATE_EVENT_SPOOL_MAX_BYTES",
	"SUBSTRATE_EVENT_SPOOL_TTL_H",
	"SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS",
	"SUBSTRATE_REFUSED_EMITS_MAX_BYTES",
	"SUBSTRATE_STATE_DIR",
	"SUBSTRATE_URL",
	"SUBSTRATE_TOKEN",
	"SUBSTRATE_TOKEN_FILE",
	"SUBSTRATE_TOKENS_DIR",
	"SUBSTRATE_TIMEOUT_MS",
] as const;

/**
 * Clear every spool and credential variable, point the tokens directory at an empty temp directory (never the
 * host's), and return the function that restores the snapshot. The spool is explicitly `off` until a test turns it on.
 */
export function isolateSpoolEnv(): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key of SPOOL_TEST_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	process.env.SUBSTRATE_EVENT_SPOOL = "off";
	process.env.SUBSTRATE_TOKENS_DIR = mkdtempSync(join(tmpdir(), "spool-test-no-tokens-"));
	return () => {
		for (const key of SPOOL_TEST_ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	};
}

/** The environment a spawned child gets: an allowlist plus the isolated tokens directory, never `...process.env`. */
export function isolatedChildEnv(extra: Record<string, string>): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		SUBSTRATE_TOKENS_DIR: mkdtempSync(join(tmpdir(), "spool-test-no-tokens-")),
		...extra,
	};
}
