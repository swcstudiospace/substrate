/**
 * `@substrate/audit` — the hash-chained record of what agents asked substrate-mcp
 * to do and whether it was allowed.
 *
 * Deliberately not `agent_events`. See the header of `record.ts` and
 * `docs/mcp-audit.md`.
 */
export {
	type AuditMode,
	type AuditRecord,
	type AuditRecordInput,
	type AuditStats,
	type AuditTransport,
	type ChainVerdict,
	ChainWalker,
	MAX_ARG_KEY,
	MAX_ARG_KEYS,
	MAX_IDENTIFIER,
	MAX_RECORD_BYTES,
	MAX_TOOL_NAME,
	NO_POSITION,
	StatsAccumulator,
	argDigest,
	auditStats,
	buildRecord,
	canonicalJson,
	isAuditRecord,
	recordHash,
	sanitizeField,
	sealRecord,
	sha256Hex,
	verifyAuditChain,
} from "./record.ts";

export {
	type AuditReport,
	AuditLog,
	AuditUnavailableError,
	listAuditSegments,
	orderSegments,
	parseSegmentName,
	MAX_WALK_ATTEMPTS,
	rolloverBytesFromEnv,
	segmentPath,
	verifyAuditSegments,
	walkAuditFiles,
} from "./log.ts";

export {
	type ClaimDecision,
	FAIL_CLOSED_TOOLS,
	FAIL_OPEN_TOOLS,
	auditMode,
	decideClaim,
} from "./policy.ts";
