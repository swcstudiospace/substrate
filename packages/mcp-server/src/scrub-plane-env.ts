/**
 * Scrubs the data-plane URL variables from `process.env` for a test process.
 *
 * CI's runner is clean; a hand-run `bun test` on the VPS inherits the operator's
 * `substrate.env`, and literals below (health rows, config snapshots) assume a
 * bare config — a leaked `HINDSIGHT_URL` turns an expected `ok: null` plane row
 * into a live probe against production. Config reads under test inject their
 * own env explicitly, so scrubbing once at file top is safe on every path.
 */
export function scrubPlaneEnv(): void {
	for (const name of [
		"GREPTIME_URL", "GREPTIME_USER", "GREPTIME_PASSWORD", "GREPTIME_DB",
		"SUBSTRATE_PG_URL", "DRAGONFLY_URL", "SUBSTRATE_CACHE",
		"HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS", "HINDSIGHT_BANK_PREFIX",
		"RAGFLOW_URL", "RAGFLOW_API_KEY", "RAGFLOW_MCP_URL",
		"LIGHTRAG_URL", "LIGHTRAG_API_KEY", "SUBSTRATE_LIGHTRAG_QUERY_MODE",
	]) delete process.env[name];
}
