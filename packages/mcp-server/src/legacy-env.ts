/**
 * Env keys whose presence is a mistake, named once for the two readers that
 * report them: `hindsightConfigWarnings` (config.ts) at server boot, by key,
 * to the log; and the runtime doctor (`scripts/doctor-runtime.ts`), which
 * asks `grep -q '^NAME=.'` whether the shared env file sets the NAME and
 * never reads a value.
 *
 * Lives in this package because `HINDSIGHT_*` may be spelled only under
 * `packages/mcp-server/src` (store-lock.test.ts, D26-02): the doctor imports
 * this table instead of naming the key. Side-effect-free: no imports.
 */
export interface LegacyEnvKey {
	name: string;
	/** The key that does what the legacy one suggests. */
	replacement: string;
	/** The operator-facing sentence, the same one the boot warning prints. */
	hint: string;
}

export const LEGACY_ENV_KEYS: readonly LegacyEnvKey[] = [
	{
		// The single-bank shape of the acc30a8 stub: nothing reads it, so an
		// operator who set it believes recall is configured when it is not.
		name: "HINDSIGHT_BANK",
		replacement: "HINDSIGHT_BANKS",
		hint: "HINDSIGHT_BANK is set but legacy and unread; recall fans out over HINDSIGHT_BANKS (sub-* names), so set that instead",
	},
];
