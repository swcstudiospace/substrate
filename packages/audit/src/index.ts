/**
 * `@substrate/audit` — the hash-chained record of what agents asked substrate-mcp
 * to do and whether it was allowed.
 *
 * Deliberately not `agent_events`. See the header of `record.ts` and
 * `docs/mcp-audit.md`.
 */
export {
	type AuditDecision,
	type AuditMode,
	type AuditRecord,
	type AuditRecordInput,
	type AuditStats,
	type AuditTransport,
	type ChainVerdict,
	type VerifyChainOptions,
	AUDIT_DECISIONS,
	AUDIT_TRANSPORTS,
	ChainWalker,
	MAX_ARG_KEY,
	MAX_ARG_KEYS,
	MAX_IDENTIFIER,
	MAX_RECORD_BYTES,
	MAX_TOOL_NAME,
	NO_POSITION,
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
	type AuditAppend,
	type AuditLogOptions,
	type MissingHistory,
	AuditLog,
	AuditUnavailableError,
} from "./log.ts";

export {
	type ClaimDecision,
	type ClaimVerdict,
	FAIL_CLOSED_TOOLS,
	FAIL_OPEN_TOOLS,
	auditMode,
	decideClaim,
} from "./policy.ts";
