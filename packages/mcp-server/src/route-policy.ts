/**
 * Phase 72: the declarations that decide which routes and MCP tools a scoped caller may reach.
 *
 * Default deny. When scoping is enforced (`SUBSTRATE_REPO_SCOPES` set), a route or tool that is not declared here is refused for
 * every caller, and a route added later is refused until someone declares it. A declaration is one of two things:
 *
 * - `repo-gated`: the handler checks the caller's grant before it reads or writes, and names the check that does so.
 * - `global`: the handler reads or writes no repository data, and the reason says why.
 *
 * The declarations are checked against the handlers by tests, which request each one as a scoped caller. Every name below is a
 * route path (`server.ts`) or a registered tool name (`mcp.ts`), and nothing here is a prefix match except `/steering/`, which is
 * not declared at all.
 */

export type Declaration = { kind: "repo-gated"; by: string } | { kind: "global"; reason: string };

const GATED = (by: string): Declaration => ({ kind: "repo-gated", by });
const GLOBAL = (reason: string): Declaration => ({ kind: "global", reason });

/** REST routes, by path. The method is not part of the declaration: each path's handler gates every method it serves. */
export const REST_ROUTE_POLICY: Readonly<Record<string, Declaration>> = {
	"/brief": GATED("scopedBriefRefusal: the named repository, and a named graph's repository, must be granted"),
	"/memory/recall": GATED("scopedRepoRefusal: the named repository must be granted"),
	"/session/context": GATED("scopedRepoRefusal: the named repository must be granted"),
	"/handoff": GATED("scopedWriteRefusal: the named repository and any named graph's repository must be granted and agree"),
	"/handoffs": GATED("scopedGraphRefusal: the graph's repository must be granted before its packets are read"),
	"/drift": GATED("scopedDriftScan: the repository and any path must be granted"),
	"/worktrees": GATED("listWorktrees: a named repository must be granted; otherwise the store reads granted rows only"),
	"/corpus/proof": GATED("corpusProofReply: the named repository must be granted before the tree is read"),
	"/corpus/plan": GATED("corpusPlanReply: every repository the plan reads must be granted"),
	"/corpus/ingest": GATED("corpusIngestReply: every repository the ingest writes must be granted"),
	"/corpus/status": GATED("corpusStatusReply: refused to a scoped caller, since the status spans every repository"),
	"/corpus/reconcile": GATED("corpusReconcileReply: refused to a scoped caller, since it reads and writes every repository"),
	"/cross-repo/fanout": GATED("crossRepoFanoutReply: every repository the operation names must be granted to the caller's surface and listed in its session allowlist"),
	"/cross-repo/status": GATED("crossRepoStatusReply: the operation is returned only when every repository it names is granted to the caller's surface and session"),
	"/cross-repo/compensate": GATED("compensateBranchFanout: operator only, refused to a non-operator before the store is read; every repository the operation names must be granted to the caller's surface and listed in its session allowlist"),
	"/events": GATED("scopedWriteRefusal: the named repository, or the named graph's repository, must be granted"),
	"/events/query": GATED("queryEventsFor: a named repository must be granted, and only granted rows are returned"),
	"/docs/search": GATED("scopedDocsRefusal: refused to a scoped caller, since the docs corpus spans every repository"),
	"/docs/lightrag/query": GATED("scopedDocsRefusal: refused to a scoped caller, since the LightRAG corpus spans every repository"),
	"/.well-known/agent-card.json": GLOBAL("the public capability card; it names no repository"),
	"/healthz": GLOBAL("liveness of the process; it reads no repository data"),
	"/livez": GLOBAL("liveness of the process; it reads no repository data"),
	"/metrics": GLOBAL("process counters; they carry no repository content"),
	"/slo": GLOBAL("service-level aggregates across every surface; they carry no repository content"),
	"/slo/history": GLOBAL("service-level aggregates over time; they carry no repository content"),
	"/rag/state": GLOBAL("the RAG state machine snapshot; it names no repository"),
	"/mcp": GLOBAL("the MCP transport; each tool it carries is checked against MCP_TOOL_POLICY before it runs"),
};

/** MCP tools, by registered name. Every tool not listed here is refused to a scoped caller. */
export const MCP_TOOL_POLICY: Readonly<Record<string, Declaration>> = {
	memory_brief: GATED("scopedBriefRefusal: the named repository, and a named graph's repository, must be granted"),
	memory_recall: GATED("scopedRepoRefusal: the named repository must be granted"),
	memory_search: GATED("scopedRepoRefusal for a named repository; memoryReplyInGrant filters the entries before the reply (derived hits are not yet filtered, RS-07)"),
	memory_verify: GATED("memoryVerify: the reader's repository must be granted before the index is read"),
	session_context: GATED("scopedRepoRefusal: the named repository must be granted"),
	events_emit: GATED("scopedWriteRefusal: the named repository, or the named graph's repository, must be granted"),
	events_query: GATED("queryEventsFor: a named repository must be granted, and only granted rows are returned"),
	graph_get: GATED("scopedGraphRefusal: the graph's repository must be granted before its content is read"),
	graph_register: GATED("scopedWriteRefusal: the named repository must be granted, and an existing graph must belong to it"),
	graph_bind: GATED("scopedGraphRefusal: the graph's repository must be granted before the binding is written"),
	graph_claim: GATED("scopedGraphRefusal: the graph's repository must be granted before the lease is taken"),
	graph_heartbeat: GATED("scopedGraphRefusal: the graph's repository must be granted before the lease is renewed"),
	graph_release: GATED("scopedGraphRefusal: the graph's repository must be granted before the lease is released"),
	graph_complete: GATED("scopedGraphRefusal: the graph's repository must be granted before the node is completed"),
	docs_search: GATED("scopedDocsRefusal: refused to a scoped caller, since the docs corpus spans every repository"),
	docs_lightrag_query: GATED("scopedDocsRefusal: refused to a scoped caller, since the LightRAG corpus spans every repository"),
	worktree_list: GATED("listWorktrees: a named repository must be granted; otherwise the store reads granted rows only"),
	coord_drift_scan: GATED("scopedDriftScan: the repository and any path must be granted"),
	coord_handoff: GATED("scopedWriteRefusal: the named repository and any named graph's repository must be granted and agree"),
	coord_handoff_list: GATED("scopedGraphRefusal: the graph's repository must be granted before its packets are read"),
	coord_reap_leases: GATED("reapExpiredLeases: reaps granted repositories only; an unnamed reap reaps each granted one in turn"),
	corpus_status: GATED("corpusStatusReply: refused to a scoped caller, since the status spans every repository"),
	corpus_ingest: GATED("corpusIngestReply: every repository the ingest writes must be granted"),
	cross_repo_fanout: GATED("crossRepoFanoutReply: every repository the operation names must be granted to the caller's surface and listed in its session allowlist"),
	cross_repo_status: GATED("crossRepoStatusReply: the operation is returned only when every repository it names is granted to the caller's surface and session"),
	railway_cost: GLOBAL("read-only cost of the configured Railway projects; no repository content"),
	railway_list: GLOBAL("read-only list of Railway projects and services; no repository content"),
	railway_monitor: GLOBAL("read-only status of one Railway service; no repository content"),
	fabric_status: GLOBAL("read-only status of the data-plane resources; no repository content"),
	fabric_compliance: GLOBAL("read-only compliance checks of the data plane; no repository content"),
	fabric_optimize: GLOBAL("read-only capacity suggestions; no repository content"),
	docs_rag_state: GLOBAL("the RAG state machine snapshot; it names no repository"),
};

/** The declaration for a REST path, or undefined when the path is not declared (refused to a scoped caller). */
export function restDeclaration(path: string): Declaration | undefined {
	return Object.hasOwn(REST_ROUTE_POLICY, path) ? REST_ROUTE_POLICY[path] : undefined;
}

/** The declaration for a tool name, or undefined when the tool is not declared (refused to a scoped caller). */
export function toolDeclaration(tool: string): Declaration | undefined {
	return Object.hasOwn(MCP_TOOL_POLICY, tool) ? MCP_TOOL_POLICY[tool] : undefined;
}
