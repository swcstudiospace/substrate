/**
 * The typed registry of every environment variable read by TypeScript under
 * `packages/` and `scripts/` (uplift-5 U5-7). SCOPE: the Python dispatcher
 * (`packages/dispatcher`) and the infra shell (`infra/vps/*.sh`) are NOT
 * covered; their variables (for example `SUBSTRATE_DISPATCH_MODEL`,
 * `SUBSTRATE_HOST_URL`, `SUBSTRATE_HEALTH_TIMEOUT`) have no row here. The
 * scanner's other blind spots are listed in `flag-registry-scan.ts`.
 *
 * Why it exists: about twenty policies ship in `shadow`, `report`, `off` or
 * unset, and nothing told an operator WHEN a flip is safe; and the names code
 * reads had drifted from `.env.example` (`SUBSTRATE_APPROVAL_*`,
 * `SUBSTRATE_BURN_COST_USD_PER_HOUR`, `SUBSTRATE_DOCS_TIMEOUT_MS`, … were read
 * and written down nowhere). This table is the one source for the names, their
 * kinds, defaults and ranges, and for the promotion evidence the advisor
 * (`scripts/promote-advisor.ts`) judges. `scripts/config-reference.ts` renders
 * it to `docs/config-reference.md`; `flag-registry.test.ts` fails when code
 * reads a name that has no row here (`flag-registry-scan.ts`) or when a row
 * marked `documented` is missing from `.env.example`.
 *
 * What it is NOT: it does not drive `loadConfig`. `config.ts` is a set of
 * bespoke parsers with distinct fallbacks (admission, ledger, Hindsight,
 * metrics history); rewriting them to read this table would be a behaviour
 * change for a documentation benefit. The rows describe the readers; the lock
 * test is what keeps the two honest. A row therefore never changes behaviour.
 *
 * Where it lives: inside `packages/mcp-server/src` because it names
 * `GREPTIME_*` and `HINDSIGHT_*` variables, which the store lock allows only
 * here (`legacy-env.ts` is the precedent). Scripts import it; they never spell
 * those names.
 *
 * Adding a flag: add ONE object literal to `FLAGS` (or one family to
 * `FLAG_FAMILIES` when the code composes the name at run time). A policy flag
 * also carries `policy`, whose `evidence` thresholds are PROPOSALS: inferences
 * from the uplift-5 recon, not measured SLOs. They are starting points for the
 * operator to accept or change, and the advisor prints them as proposed.
 *
 * Side-effect-free: imports only constants.
 */
import { ADMISSION_CLASSES } from "@substrate/observability";
import type { EnvRead } from "./flag-registry-scan.ts";
import { SURFACES } from "./types.ts";

export type FlagKind = "mode" | "toggle" | "number" | "path" | "list" | "secret-ref" | "string";

/** One data plane or owner; the reference document has one table per entry, in this order. */
export const FLAG_PLANES = [
	"identity",
	"server",
	"ledger",
	"index",
	"cache",
	"brief",
	"recall",
	"docs",
	"admission",
	"observability",
	"vps",
	"host",
	"clients",
	"harness",
] as const;
export type FlagPlane = (typeof FLAG_PLANES)[number];

export const FLAG_PLANE_TITLES: Readonly<Record<FlagPlane, string>> = {
	identity: "Identity, tokens and memory governance",
	server: "Server, trackers and desktop",
	ledger: "Event ledger (GreptimeDB) and anchors",
	index: "Index (Postgres) and memory lifetime",
	cache: "Cache (loopback redis)",
	brief: "Brief and recall-in-the-brief",
	recall: "Recall plane (Hindsight)",
	docs: "Documents plane (RAGFlow)",
	admission: "Admission budgets and circuit breakers",
	observability: "Observability, SLOs and metrics history",
	vps: "VPS runtime, doctor and disk guardrails",
	host: "Substrate host (VM sandboxes)",
	clients: "CLI, collectors and projectors",
	harness: "Smoke, rehearsal and test harness",
};

export type Comparator = "<=" | ">=" | "<" | ">" | "==";

/** A set of points of one history series: those whose closed label value is in `labels` (all of them when omitted). */
export interface SeriesTerm {
	series: string;
	labels?: readonly string[];
}

/** `share`: sum of the numerator's values over sum of the denominator's values (the whole numerator series when there is no denominator). `ratio`: sum of the numerator's values over the sum of the denominator's sample counts. `max`: worst value. `sum`: total value. */
export type EvidenceStat = "share" | "ratio" | "max" | "sum";

/**
 * The extended series that proves EXTENDED sampling covered a window: a gauge the extended sampler writes in
 * every interval (the retain outbox depth is set at boot and never absent), so a row exists whether or not the
 * interval had any traffic. A criterion over an extended series treats a missing counter row as zero only if this
 * series spans the window without a long gap; core series cannot prove it, because extended history starts when
 * `SUBSTRATE_METRICS_HISTORY_SERIES=extended` was enabled and the series before that are absent, not zero.
 */
export const EXTENDED_COVERAGE_SERIES = "hindsight.outbox_size";

/**
 * One promotion criterion, judged from `GET /slo/history`. `proposed` is the
 * literal `true`: every threshold here is a proposal, never a measured SLO.
 */
export interface Evidence {
	/** Short row name in the advisor report. */
	id: string;
	stat: EvidenceStat;
	numerator: SeriesTerm;
	/** For `share`: the points the share is of (the whole numerator series when omitted). For `ratio`: required, a series whose sample counts divide the numerator. */
	denominator?: SeriesTerm;
	comparator: Comparator;
	threshold: number;
	/** How the number prints: `share` as a percentage, the rest as a plain number with the unit. */
	unit: "share" | "ms" | "bytes" | "bytes/brief" | "count";
	/** Denominator sum (share, ratio) or observation count (max, sum) the judgement needs before it is made. */
	minSamples: number;
	/** The `/slo/history` window asked for, `<n><m|h|d>`. */
	window: string;
	/** `extended` series exist only with `SUBSTRATE_METRICS_HISTORY_SERIES=extended`; without it the criterion is series-unavailable. */
	needs: "core" | "extended";
	rationale: string;
	/** One short caveat the advisor prints on the criterion's line and the runbook table carries (for example that the measured number is a bound). */
	note?: string;
	proposed: true;
}

export interface PolicySpec {
	/** The value that preserves today's behaviour or only reports. */
	safe: string;
	/** The value that makes the policy bite. */
	enforcing: string;
	/** The one-line operator step. Code never performs it. */
	step: string;
	rollback: string;
	/** Judged by the advisor; empty for a flag whose evidence is not in the history. */
	evidence: readonly Evidence[];
	/** Where to look when `evidence` is empty. */
	manual?: string;
}

export interface FlagSpec {
	name: string;
	kind: FlagKind;
	plane: FlagPlane;
	/** The value the code uses when the variable is unset or invalid; `none` when there is no default. */
	default: string;
	/** Accepted values or range; empty when free-form. */
	allowed: string;
	/** What an unset variable means, in one sentence. */
	unset: string;
	/** The owning reader, repo-relative without `packages/` and `src/`. Descriptive: the lock test checks the name is read somewhere. */
	readBy: string;
	/** Whether `.env.example` carries a `NAME=` line (live or commented). The lock test enforces it. */
	documented: boolean;
	/** `unread`: written down but no code reads it today. `legacy`: read only to warn. `shell`: read only by the infra shell file `readBy` names, which the TypeScript scan does not cover. */
	status?: "active" | "unread" | "legacy" | "shell";
	/** A doc that describes it, repo-relative. The lock test checks the file exists. */
	doc?: string;
	policy?: PolicySpec;
}

/** A group of names the code composes at run time. The scan finds only the prefix, so the family names it. */
export interface FlagFamily {
	/** Display form, e.g. `SUBSTRATE_TOKEN_<SURFACE>`. */
	pattern: string;
	/** The template prefix the scan reports. */
	prefix: string;
	kind: FlagKind;
	plane: FlagPlane;
	default: string;
	allowed: string;
	unset: string;
	readBy: string;
	/** Every concrete name the family can read. */
	members: readonly string[];
	/** The members `.env.example` must carry. */
	documentedMembers: readonly string[];
	doc?: string;
}

const spelled = (surface: string): string => surface.toUpperCase().replace(/-/g, "_");

const TOKEN_NAMES: readonly string[] = SURFACES.map((surface) => `SUBSTRATE_TOKEN_${spelled(surface)}`);
const CLASS_BUDGET_NAMES: readonly string[] = ADMISSION_CLASSES.flatMap((klass) => [`SUBSTRATE_BUDGET_${klass.toUpperCase()}_RPS`, `SUBSTRATE_BUDGET_${klass.toUpperCase()}_BURST`]);
const SURFACE_BUDGET_NAMES: readonly string[] = SURFACES.flatMap((surface) =>
	ADMISSION_CLASSES.flatMap((klass) => [`SUBSTRATE_BUDGET_${spelled(surface)}_${klass.toUpperCase()}_RPS`, `SUBSTRATE_BUDGET_${spelled(surface)}_${klass.toUpperCase()}_BURST`]),
);

export const FLAG_FAMILIES: readonly FlagFamily[] = [
	{
		pattern: "SUBSTRATE_TOKEN_<SURFACE>",
		prefix: "SUBSTRATE_TOKEN_",
		kind: "secret-ref",
		plane: "identity",
		default: "none",
		allowed: "comma or space separated bearer tokens, 16 characters or more",
		unset: "that surface has no token; with no surface token at all the server accepts untokened callers",
		readBy: "mcp-server/config.ts",
		members: TOKEN_NAMES,
		documentedMembers: TOKEN_NAMES,
		doc: "docs/swarm-workspace.md",
	},
	{
		pattern: "SUBSTRATE_BUDGET_<CLASS>_RPS | _BURST",
		prefix: "SUBSTRATE_BUDGET_",
		kind: "number",
		plane: "admission",
		default: "read 20/40, write 10/20, coordination 30/60 (rps/burst)",
		allowed: "positive number (rps) or positive integer (burst)",
		unset: "the class default; per-surface SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS | _BURST override a half and the half left out is the class value",
		readBy: "mcp-server/config.ts",
		members: [...CLASS_BUDGET_NAMES, ...SURFACE_BUDGET_NAMES],
		documentedMembers: CLASS_BUDGET_NAMES,
		doc: "docs/observability.md",
	},
	{
		pattern: "SUBSTRATE_REHEARSAL_<NAME>",
		prefix: "SUBSTRATE_REHEARSAL_",
		kind: "string",
		plane: "harness",
		default: "none",
		allowed: "harness-owned",
		unset: "the rehearsal harness refuses to start the dependent smoke",
		readBy: "scripts/rehearsal.ts",
		// The scratch ledger image name is composed in rehearsal.ts so that file never holds the ledger-key substring the store lock scans for.
		members: ["SUBSTRATE_REHEARSAL_GREPTIME_IMAGE"],
		documentedMembers: [],
		doc: "docs/rehearsal.md",
	},
];

/**
 * Names the code touches that are not Agent Substrate configuration, each with
 * the reason. A trailing `_` exempts a template prefix. The lock test accepts a
 * read of any of these without a registry row; nothing else gets that.
 */
export const REGISTRY_EXEMPT: readonly { name: string; reason: string }[] = [
	{ name: "HOME", reason: "platform variable; the code only reads it to build default paths" },
	{ name: "PATH", reason: "platform variable passed through to child processes" },
	{ name: "PYTHONPATH", reason: "platform variable the Lane A harness extends for the dispatcher child" },
	{ name: "XDG_RUNTIME_DIR", reason: "platform variable naming the per-user runtime directory" },
	{ name: "NOTIFY_SOCKET", reason: "set by systemd for a Type=notify unit; read by the watchdog, never configured" },
	{ name: "WATCHDOG_USEC", reason: "set by systemd from WatchdogSec; never configured" },
	{ name: "WATCHDOG_PID", reason: "set by systemd; never configured" },
	{ name: "SERVICE_RESULT", reason: "set by systemd on OnFailure units; read by substrate-alert, never configured" },
	{ name: "MONITOR_SERVICE_RESULT", reason: "set by systemd for the monitor unit; never configured" },
	{ name: "DOCKER_HOST", reason: "the docker client's own variable; the rehearsal harness refuses a remote value rather than configuring it" },
	{ name: "DOCKER_CONTEXT", reason: "the docker client's own variable; refused when it is not the local context" },
	{ name: "DOCKER_CONFIG", reason: "the docker client's own variable, passed through to the scratch stack" },
	{ name: "GIT_OPTIONAL_LOCKS", reason: "written into a child git environment, never read" },
	{ name: "HERDR_", reason: "prefix scrubbed from the child environment by the Lane B proof; the harness deletes these, it reads none" },
	{ name: "SUBSTRATE_DASHBOARD_URL", reason: "Grafana-side variable the dashboards generator names in its provisioning example; Grafana reads it, no substrate process does" },
	{ name: "SUBSTRATE_DASHBOARD_BEARER", reason: "Grafana-side variable the dashboards generator names in its provisioning example; Grafana reads it, no substrate process does" },
];

/**
 * Every environment variable the code reads. Sorted by plane, then name; the
 * order is the document's order.
 */
export const FLAGS: readonly FlagSpec[] = [
	// ── identity ──────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_ALLOW_ANONYMOUS", kind: "toggle", plane: "identity", default: "none", allowed: "1 | true | yes | 0 | false | no (case-insensitive; anything else is unset)", unset: "untokened callers are accepted only while no surface token is configured; 1 keeps them alongside tokens, 0 requires a bearer", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_OPERATOR_TOKENS", kind: "secret-ref", plane: "identity", default: "none", allowed: "comma separated tokens", unset: "no operator authority; each must also be a surface token", readBy: "mcp-server/config.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_MEMORY_REVIEW_TOKENS", kind: "secret-ref", plane: "identity", default: "none", allowed: "comma or space separated, 16+ characters", unset: "global memories, human-confirmed trust and quarantine release stay closed", readBy: "mcp-server/config.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_MEMORY_GRANTS", kind: "string", plane: "identity", default: "none", allowed: "JSON array of grants", unset: "only the default-deny RBAC policy; malformed entries are dropped with a warning", readBy: "mcp-server/config.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_HANDOFF_KEY", kind: "secret-ref", plane: "identity", default: "none", allowed: "signing key", unset: "signed handoffs are unavailable", readBy: "mcp-server/config.ts", documented: true, doc: "docs/coordination.md" },
	{ name: "SUBSTRATE_HANDOFF_KEY_ID", kind: "string", plane: "identity", default: "k1", allowed: "key id", unset: "k1", readBy: "mcp-server/config.ts", documented: true, doc: "docs/coordination.md" },
	{ name: "SUBSTRATE_HANDOFF_KEY_PREV", kind: "secret-ref", plane: "identity", default: "none", allowed: "previous signing key", unset: "no previous key; packets signed under it stop verifying", readBy: "mcp-server/config.ts", documented: true, doc: "docs/coordination.md" },
	{ name: "SUBSTRATE_HANDOFF_KEY_PREV_ID", kind: "string", plane: "identity", default: "k0", allowed: "key id", unset: "k0", readBy: "mcp-server/config.ts", documented: true, doc: "docs/coordination.md" },
	{ name: "SUBSTRATE_LEASE_TTL_SECONDS", kind: "number", plane: "identity", default: "900", allowed: "30..86400 (clamped)", unset: "900 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/coordination.md" },
	{ name: "SUBSTRATE_AUDIT_PATH", kind: "path", plane: "identity", default: "none", allowed: "absolute file path", unset: "no durable audit chain: the server boots with a warning and fail-closed tools refuse", readBy: "mcp-server/config.ts", documented: true, doc: "docs/mcp-audit.md" },
	{ name: "SUBSTRATE_AUDIT_ROLLOVER_BYTES", kind: "number", plane: "identity", default: "none", allowed: "positive integer bytes", unset: "the audit chain never rolls", readBy: "audit/log.ts", documented: true, doc: "docs/mcp-audit.md" },
	{ name: "SUBSTRATE_TOKEN", kind: "secret-ref", plane: "identity", default: "none", allowed: "one bearer token", unset: "the client falls back to SUBSTRATE_TOKEN_FILE, then the tokens directory", readBy: "cli/token.ts, host/substrate.ts, scripts", documented: true, doc: "docs/swarm-workspace.md" },
	{ name: "SUBSTRATE_TOKEN_FILE", kind: "path", plane: "identity", default: "none", allowed: "file holding one token", unset: "the client falls back to the tokens directory", readBy: "cli/token.ts, host/substrate.ts", documented: true, doc: "docs/swarm-workspace.md" },
	{ name: "SUBSTRATE_TOKENS_DIR", kind: "path", plane: "identity", default: "/etc/substrate/tokens", allowed: "directory of per-surface token files", unset: "the default directory", readBy: "cli/token.ts, host/substrate.ts", documented: true, doc: "docs/swarm-workspace.md" },

	// ── server ────────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_HOST", kind: "string", plane: "server", default: "127.0.0.1", allowed: "bind address", unset: "loopback", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_PORT", kind: "number", plane: "server", default: "7410", allowed: "port", unset: "7410", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_URL", kind: "string", plane: "server", default: "http://127.0.0.1:7410", allowed: "base URL", unset: "clients use the loopback default; a swarm workspace with it unset is off", readBy: "cli, projector, scripts/doctor-runtime.ts", documented: true },
	{ name: "SUBSTRATE_PUBLIC_ORIGIN", kind: "string", plane: "server", default: "https://substrate.swcstudio.space", allowed: "https origin", unset: "https://substrate.swcstudio.space", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_DESKTOP_SURFACES", kind: "list", plane: "server", default: "none", allowed: "comma separated known surfaces", unset: "nobody may call desktop_run", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/desktop.md" },
	{ name: "SUBSTRATE_DESKTOP_DIR", kind: "path", plane: "server", default: "/var/lib/substrate/desktop", allowed: "absolute path", unset: "the default; a relative value is refused with a boot warning", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/desktop.md" },
	{ name: "SUBSTRATE_SKILLS_REPO", kind: "string", plane: "server", default: "swcstudiospace/agent-skills", allowed: "owner/repo", unset: "the production skills library", readBy: "mcp-server/config.ts", documented: true, doc: "docs/skills-propose.md" },
	{ name: "SUBSTRATE_SKILLS_REMOTE_URL", kind: "string", plane: "server", default: "https://github.com/swcstudiospace/agent-skills.git", allowed: "git remote URL", unset: "the production remote", readBy: "mcp-server/config.ts", documented: true, doc: "docs/skills-propose.md" },
	{ name: "SUBSTRATE_SKILLS_STATE", kind: "path", plane: "server", default: "/var/lib/substrate/skills", allowed: "directory", unset: "the default state directory", readBy: "mcp-server/config.ts", documented: true, doc: "docs/skills-propose.md" },
	{ name: "SUBSTRATE_SKILLS_GH", kind: "string", plane: "server", default: "gh", allowed: "gh binary", unset: "gh from PATH", readBy: "mcp-server/config.ts", documented: true, doc: "docs/skills-propose.md" },
	{
		name: "SUBSTRATE_SKILLS_GOVERNANCE",
		kind: "mode",
		plane: "server",
		default: "off",
		allowed: "off | report | enforce (case- and space-insensitive; anything else is off with a boot warning)",
		unset: "off: skills_propose records no registry row, nothing is filtered, and the skills projector makes no fetch (skills_approve and skills_list still exist)",
		readBy: "mcp-server/config.ts, projector/skills-governance.ts",
		documented: true,
		doc: "docs/runbooks/skills-governance.md",
		policy: {
			safe: "off",
			enforcing: "enforce",
			step: "set report in BOTH the server env and the skills-sync unit env, soak, approve every skill already on the library's main with skills_approve, wait for the skills.sync unapproved warning to stop, then set enforce on the skills-sync unit only",
			rollback: "set off in both places; the registry table is additive and nothing is unlinked or deleted by code",
			evidence: [],
			manual: "the periodic skills.sync warning (reason unapproved) names no skill, and skills_list (operator, state=all) shows every skill on main as approved",
		},
	},
	{ name: "LINEAR_API_KEY", kind: "secret-ref", plane: "server", default: "none", allowed: "Linear API key", unset: "Linear sync is off", readBy: "mcp-server/config.ts, host/sync.ts", documented: true },
	{ name: "LINEAR_API_URL", kind: "string", plane: "server", default: "https://api.linear.app/graphql", allowed: "URL", unset: "the real API; the rehearsal points it at a loopback fake", readBy: "mcp-server/config.ts", documented: true, doc: "docs/rehearsal.md" },
	{ name: "NOTION_API_KEY", kind: "secret-ref", plane: "server", default: "none", allowed: "Notion integration key", unset: "Notion sync is off", readBy: "mcp-server/config.ts, host/sync.ts", documented: true },
	{ name: "NOTION_API_URL", kind: "string", plane: "server", default: "https://api.notion.com", allowed: "URL", unset: "the real API; the rehearsal points it at a loopback fake", readBy: "mcp-server/config.ts", documented: true, doc: "docs/rehearsal.md" },
	{ name: "NOTION_TASK_GRAPH_DS", kind: "string", plane: "server", default: "the repo's task-graph data source id", allowed: "data source id", unset: "the built-in id", readBy: "mcp-server/config.ts, host/sync.ts", documented: true },
	{ name: "HERMES_LINEAR_URL", kind: "string", plane: "server", default: "http://127.0.0.1:8792", allowed: "URL", unset: "the connector's loopback address", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_DOD_GATE_TIMEOUT_MS", kind: "number", plane: "server", default: "35000", allowed: "positive integer ms", unset: "35000 ms", readBy: "mcp-server/config.ts", documented: true },

	// ── ledger ────────────────────────────────────────────────────────────────
	{ name: "GREPTIME_URL", kind: "secret-ref", plane: "ledger", default: "none", allowed: "HTTP SQL base URL", unset: "no ledger: events are not recorded and claims are not withdrawn for it", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "GREPTIME_USER", kind: "secret-ref", plane: "ledger", default: "none", allowed: "user", unset: "unauthenticated ledger calls", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "GREPTIME_PASSWORD", kind: "secret-ref", plane: "ledger", default: "none", allowed: "password", unset: "unauthenticated ledger calls", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "GREPTIME_DB", kind: "string", plane: "ledger", default: "public", allowed: "database name", unset: "public", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER", kind: "toggle", plane: "ledger", default: "false", allowed: "1 | true | yes (case-insensitive; anything else is off)", unset: "appends are refused unless agent_events is provably in append_mode", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_CLAIM_REQUIRE_LEDGER", kind: "toggle", plane: "ledger", default: "on when a ledger is configured", allowed: "1 | true | yes | 0 | false | no (case-insensitive; anything else is unset)", unset: "a claim whose event did not reach the ledger is withdrawn when a ledger is configured", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_CHAIN_CACHE", kind: "toggle", plane: "ledger", default: "on", allowed: "0 | false | no turns it off", unset: "chain-tip cache on", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_CHAIN_CACHE_MAX", kind: "number", plane: "ledger", default: "10000", allowed: "1..1000000", unset: "10000 sessions", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS", kind: "number", plane: "ledger", default: "30", allowed: "1..3650", unset: "30 days", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_WRITE_PROBE_S", kind: "number", plane: "ledger", default: "60", allowed: "0..86400 (0 never probes)", unset: "60 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{
		name: "SUBSTRATE_LEDGER_TTL",
		kind: "string",
		plane: "ledger",
		default: "none",
		allowed: "Greptime duration (180d, 4320h, 1h30m)",
		unset: "no ALTER: retention is left as the table has it; a malformed value refuses to boot",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/greptime-ledger.md",
		policy: {
			safe: "unset",
			enforcing: "180d",
			step: "export the window first (substrate ledger archive), then set SUBSTRATE_LEDGER_TTL=180d in the unit env and restart",
			rollback: "unset it and restart; an ALTER already applied stays until an operator changes the table",
			evidence: [],
			manual: "substrate ledger coverage exits 0 and /healthz.jobs.ledger reports no uncovered hours (SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS); every expiring day has a verified archive manifest",
		},
	},
	{ name: "SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS", kind: "number", plane: "ledger", default: "2", allowed: "0..100000", unset: "2 hours", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_ARCHIVE_DIR", kind: "path", plane: "ledger", default: "none", allowed: "off-box mount", unset: "substrate ledger archive refuses by name unless --out is given", readBy: "mcp-server/config.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS", kind: "toggle", plane: "ledger", default: "false", allowed: "1 | true | yes (case-insensitive; anything else is off)", unset: "an archive on the root filesystem is refused", readBy: "mcp-server/ledger-run.ts, index-archive.ts", documented: true, doc: "docs/greptime-ledger.md" },
	{ name: "SOLANA_RPC_URL", kind: "string", plane: "ledger", default: "https://api.devnet.solana.com", allowed: "URL", unset: "public devnet", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SOLANA_ANCHOR_KEYPAIR", kind: "path", plane: "ledger", default: "none", allowed: "keypair file path", unset: "the hourly anchor job is not configured", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SOLANA_ANCHOR_PUBKEY", kind: "string", plane: "ledger", default: "none", allowed: "public key", unset: "anchors are not verified against a key", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SOLANA_CLI", kind: "path", plane: "ledger", default: "the solana CLI install path", allowed: "binary", unset: "the built-in path", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_VERIFY_TIMEOUT_MS", kind: "number", plane: "ledger", default: "30000", allowed: "positive ms", unset: "30000 ms", readBy: "mcp-server/config.ts", documented: true },
	{
		name: "SUBSTRATE_EVENT_IDEMPOTENCY",
		kind: "mode",
		plane: "ledger",
		default: "off",
		allowed: "off | accept | enforce (case- and space-insensitive; anything else is off with a boot warning)",
		unset: "off: POST /events ignores idempotency_key and the x-substrate-replay header; nothing is stored and responses are unchanged",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/greptime-ledger.md",
		policy: {
			safe: "off",
			enforcing: "accept",
			step: "set SUBSTRATE_EVENT_IDEMPOTENCY=accept in the unit env and restart; confirm /healthz reports idempotency accept, and only then enable a client spool; enforce only after an EXPLAIN of the lookup against the production ledger",
			rollback: "set off and restart; stored _ik payload keys are ordinary payload data",
			evidence: [],
			manual: "/healthz reports idempotency accept; substrate.events.replay{result=deduplicated} counts replays that found their row and {result=lookup_failed} stays at 0",
		},
	},

	// ── index ─────────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_PG_URL", kind: "secret-ref", plane: "index", default: "none", allowed: "postgres URL", unset: "no index: graph, memory and brief sources are unavailable", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_PG_POOL_MAX", kind: "number", plane: "index", default: "8", allowed: "1..50 (clamped)", unset: "8", readBy: "mcp-server/index-store.ts", documented: true },
	{ name: "SUBSTRATE_PG_CONNECT_TIMEOUT_MS", kind: "number", plane: "index", default: "2000", allowed: "200..60000 (clamped)", unset: "2000 ms", readBy: "mcp-server/index-store.ts", documented: true },
	{ name: "SUBSTRATE_PG_STATEMENT_TIMEOUT_MS", kind: "number", plane: "index", default: "5000", allowed: "0..600000 (0 = server default)", unset: "5000 ms", readBy: "mcp-server/index-store.ts", documented: true },
	{ name: "SUBSTRATE_PG_IDLE_TIMEOUT_S", kind: "number", plane: "index", default: "300", allowed: "0..86400 (0 = never)", unset: "300 s", readBy: "mcp-server/index-store.ts", documented: true },
	{
		name: "SUBSTRATE_MEMORY_EXPIRY",
		kind: "mode",
		plane: "index",
		default: "report",
		allowed: "report | enforce",
		unset: "report: expired entries are served tagged and counted; anything else is report with a boot warning",
		readBy: "mcp-server/memory-policy.ts, index-sweep.ts",
		documented: true,
		doc: "docs/memory-governance.md",
		policy: {
			safe: "report",
			enforcing: "enforce",
			step: "set SUBSTRATE_MEMORY_EXPIRY=enforce in BOTH the server env and the sweep job env, restart substrate-mcp; the sweep still deletes nothing without SUBSTRATE_INDEX_SWEEP=apply and --apply",
			rollback: "set SUBSTRATE_MEMORY_EXPIRY=report and restart; hidden entries come back (nothing is deleted by this flag)",
			evidence: [
				{
					id: "expired entries still served",
					stat: "sum",
					numerator: { series: "memory.expired", labels: ["served"] },
					comparator: "==",
					threshold: 0,
					unit: "count",
					minSamples: 0,
					window: "7d",
					needs: "extended",
					rationale:
						"PROPOSED. Under report an expired entry is still served (mode=served), so a non-zero count is exactly what enforce would start hiding. The series is not split by memory kind, so any served expired entry holds the flip until the operator has read the sweep dry-run for kind=decision entries; a count of zero cannot be told from 'not observed', because a counter has no row for an interval with nothing to count, so the advisor reports hold when something was served and insufficient-data otherwise: the decision rests on the manual check. Extended history starts when SUBSTRATE_METRICS_HISTORY_SERIES=extended was enabled, never earlier.",
					proposed: true,
				},
			],
			manual: "substrate index sweep (dry-run) lists no kind=decision entries in entries-ttl-* classes",
		},
	},
	{
		name: "SUBSTRATE_MEMORY_LIFECYCLE",
		kind: "mode",
		plane: "index",
		default: "report",
		allowed: "report | off",
		unset: "report: the sweep prints lifecycle candidate ids and document ids and deletes nothing; off skips that read; anything else is report with a boot warning",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/memory-governance.md",
	},
	{
		name: "SUBSTRATE_HASH_VERSION",
		kind: "mode",
		plane: "index",
		default: "v1",
		allowed: "v1 | v2",
		unset: "v1: today's hash preimage; anything else that is not v2 is v1, and an unrecognised non-empty value warns at boot",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/memory-governance.md",
		policy: {
			safe: "v1",
			enforcing: "v2",
			step: "set SUBSTRATE_HASH_VERSION=v2 and restart; new memory writes store the v2 digest and still match a row written under v1",
			rollback: "set v1 and restart; stored v2 digests stay valid and are still matched",
			evidence: [],
			manual: "a new write under v2 stores a digest that differs from the v1 preimage, and a quarantine or review parked under v1 is reused rather than inserted again",
		},
	},
	{
		name: "SUBSTRATE_INDEX_SWEEP",
		kind: "mode",
		plane: "index",
		default: "dry-run",
		allowed: "dry-run | apply | off",
		unset: "dry-run: report what the documented retention would remove, delete nothing; anything unrecognised is dry-run",
		readBy: "mcp-server/index-sweep.ts",
		documented: true,
		doc: "docs/memory-governance.md",
		policy: {
			safe: "dry-run",
			enforcing: "apply",
			step: "after reading the dry-run report, set SUBSTRATE_INDEX_SWEEP=apply on the sweep unit's drop-in (not the server env); deletion also needs substrate index sweep --apply",
			rollback: "set dry-run; rows already deleted are not restored (export first with substrate index archive)",
			evidence: [],
			manual: "substrate index sweep prints candidate counts per class; deletion is irreversible, so there is no history evidence for it",
		},
	},
	{ name: "SUBSTRATE_SWEEP_GRAPHS_DAYS", kind: "number", plane: "index", default: "90", allowed: "1..3650", unset: "90 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_SUPERSEDED_DAYS", kind: "number", plane: "index", default: "90", allowed: "1..3650", unset: "90 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS", kind: "number", plane: "index", default: "7", allowed: "1..3650", unset: "7 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS", kind: "number", plane: "index", default: "30", allowed: "1..3650", unset: "30 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_REVIEWS_DAYS", kind: "number", plane: "index", default: "30", allowed: "1..3650", unset: "30 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_QUARANTINE_DAYS", kind: "number", plane: "index", default: "30", allowed: "1..3650", unset: "30 days", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_SWEEP_BATCH", kind: "number", plane: "index", default: "500", allowed: "1..5000", unset: "500 rows per DELETE", readBy: "mcp-server/index-sweep.ts", documented: true, doc: "docs/memory-governance.md" },
	{ name: "SUBSTRATE_INDEX_ARCHIVE_DIR", kind: "path", plane: "index", default: "none", allowed: "dedicated mount", unset: "substrate index archive refuses by name and writes nothing; the index.archive.age row is absent", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{ name: "SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H", kind: "number", plane: "index", default: "none", allowed: "hours", unset: "the index.archive.age row is report-only", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{ name: "SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS", kind: "number", plane: "index", default: "900", allowed: "10..86400", unset: "900 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{ name: "SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES", kind: "number", plane: "index", default: "1073741824", allowed: "1 MiB..1 TiB", unset: "1 GiB", readBy: "mcp-server/config.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{ name: "SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS", kind: "toggle", plane: "index", default: "false", allowed: "1 | true | yes (case-insensitive; anything else is off)", unset: "an archive on the root filesystem is refused", readBy: "mcp-server/index-archive.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{ name: "SUBSTRATE_INDEX_SCRATCH_URL", kind: "secret-ref", plane: "index", default: "none", allowed: "scratch postgres URL", unset: "substrate index restore needs --scratch", readBy: "mcp-server/index-run.ts", documented: true, doc: "docs/runbooks/index-archive.md" },
	{
		name: "SUBSTRATE_INDEX_TUNE",
		kind: "mode",
		plane: "index",
		default: "off",
		allowed: "off | apply (anything but apply is off)",
		unset: "off: no storage tune; anything but apply is off",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/runbooks/index-archive.md",
		policy: {
			safe: "off",
			enforcing: "apply",
			step: "set SUBSTRATE_INDEX_TUNE=apply in the unit env and restart; migrate applies the graph_nodes tune once and idempotently",
			rollback: "unset it; the applied storage parameters stay until an operator resets them",
			evidence: [],
			manual: "/healthz.capacity.index.graphNodes shows the HOT-update and dead-row ratios the tune is meant to move",
		},
	},
	{ name: "SUBSTRATE_INDEX_VOLUME_BYTES", kind: "number", plane: "index", default: "none", allowed: "bytes", unset: "no capacity runway row (the ceiling is unknown)", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },

	// ── cache ─────────────────────────────────────────────────────────────────
	{ name: "DRAGONFLY_URL", kind: "string", plane: "cache", default: "none", allowed: "loopback redis URL", unset: "no cache; a non-loopback URL is refused with a boot warning", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_CACHE", kind: "toggle", plane: "cache", default: "on when DRAGONFLY_URL is set", allowed: "0 | false | no turns it off", unset: "on when the URL is set; anything else is unset", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS", kind: "number", plane: "cache", default: "250", allowed: "positive ms", unset: "250 ms", readBy: "mcp-server/config.ts", documented: true },
	{ name: "SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS", kind: "number", plane: "cache", default: "250", allowed: "positive ms", unset: "250 ms", readBy: "mcp-server/config.ts", documented: true },
	{
		name: "SUBSTRATE_CACHE_SWR",
		kind: "mode",
		plane: "cache",
		default: "shadow",
		allowed: "off | shadow | enforce",
		unset: "shadow: count would_serve_stale, serve the live brief exactly as before",
		readBy: "mcp-server/config.ts, cache.ts",
		documented: true,
		doc: "docs/data-planes.md",
		policy: {
			safe: "shadow",
			enforcing: "enforce",
			step: "set SUBSTRATE_CACHE_SWR=enforce in the unit env and restart substrate-mcp",
			rollback: "set SUBSTRATE_CACHE_SWR=off and restart",
			evidence: [
				{
					id: "would-serve-stale share of misses (lower bound)",
					stat: "share",
					numerator: { series: "cache.operations", labels: ["would_serve_stale"] },
					denominator: { series: "cache.operations", labels: ["miss"] },
					comparator: ">=",
					threshold: 0.1,
					unit: "share",
					minSamples: 100,
					window: "24h",
					needs: "extended",
					rationale:
						"PROPOSED. would_serve_stale is counted IN ADDITION to the miss of the same request (cache.ts counts the miss, then the shadow probe counts would_serve_stale), so it is a subset of miss and the share is would_serve_stale / miss. Below this share stale-serving answers too few misses to be worth a second code path (under 1 % it buys nothing). The history sums every cache class while would_serve_stale is counted only for the brief class, so other classes' misses inflate the denominator: the measured share is a LOWER BOUND of the brief share. A ready verdict therefore stands; a hold may understate the brief share and is worth a look at /metrics (class=brief) before it is believed.",
					note: "lower bound: cache.operations sums every cache class, would_serve_stale is brief-only",
					proposed: true,
				},
				{
					id: "brief p95 (grok-bot, worst interval)",
					stat: "max",
					numerator: { series: "brief.p95", labels: ["grok-bot"] },
					comparator: "<=",
					threshold: 800,
					unit: "ms",
					minSamples: 100,
					window: "24h",
					needs: "core",
					rationale: "PROPOSED. The brief objective already in the SLO catalogue (DEFAULT_THRESHOLDS.briefP95Ms = 800). The history keeps the worst interval p95 per bucket, so one slow interval holds the flip: stricter than the rolling-hour objective.",
					proposed: true,
				},
			],
		},
	},
	{ name: "SUBSTRATE_CACHE_SWR_WINDOW_S", kind: "number", plane: "cache", default: "30", allowed: "1..300", unset: "30 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{
		name: "SUBSTRATE_CACHE_BUMP_SCOPE",
		kind: "mode",
		plane: "cache",
		default: "legacy",
		allowed: "legacy | narrow (case- and space-insensitive; anything else is legacy, named at boot)",
		unset: "legacy: a Hindsight retain or outbox replay bumps the memory generation (flushes every brief and search, twice per forwarded write) and a heartbeat flushes graph-scoped briefs",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/data-planes.md",
		policy: {
			safe: "legacy",
			enforcing: "narrow",
			step: "set SUBSTRATE_CACHE_BUMP_SCOPE=narrow in the unit env and restart; watch substrate.cache.operations{class=brief,result=miss} per accepted write",
			rollback: "set legacy and restart; cached entries need no flush",
			evidence: [],
			manual: "brief misses per accepted write fall (one flush instead of two) and a graph-scoped brief still changes on claim, release and complete; staleness bounds are in docs/data-planes.md",
		},
	},

	// ── brief ─────────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_BRIEF_BUDGET_MS", kind: "number", plane: "brief", default: "1200", allowed: "0 = no deadline", unset: "1200 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS", kind: "number", plane: "brief", default: "30", allowed: "positive integer", unset: "30 days", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BRIEF_SNAPSHOT_TTL_S", kind: "number", plane: "brief", default: "3600", allowed: "0 = no snapshots", unset: "3600 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_HEALTHZ_CACHE_MS", kind: "number", plane: "brief", default: "5000", allowed: "0 = recompute per call", unset: "5000 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S", kind: "number", plane: "brief", default: "0", allowed: "0..300 whole seconds (a fraction is floored with a boot warning; above 300 is capped at 300 with a boot warning; negative or not a number is 0 with a boot warning)", unset: "0: the index size report (capacity.index) is measured on every computed /healthz body", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{
		name: "SUBSTRATE_BRIEF_GRAPH_READ",
		kind: "mode",
		plane: "brief",
		default: "full",
		allowed: "full | lite (case- and space-insensitive; anything else is full, named at boot)",
		unset: "full: a graph-scoped brief reads its graph with four serial statements",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/data-planes.md",
		policy: {
			safe: "full",
			enforcing: "lite",
			step: "set SUBSTRATE_BRIEF_GRAPH_READ=lite in the unit env and restart; compare the graph.brief and graph.get plane durations and graph-scoped brief p95",
			rollback: "set full and restart",
			evidence: [],
			manual: "substrate.plane.duration{plane=index,op=graph.brief} stays below the full read's graph.get; the brief text is test-pinned identical",
		},
	},
	{
		name: "SUBSTRATE_BRIEF_PROFILE",
		kind: "mode",
		plane: "brief",
		default: "shadow",
		allowed: "off | shadow | enforce",
		unset: "shadow: build the compact text, record bytes saved, serve the full text; anything else is shadow with a boot warning",
		readBy: "mcp-server/brief-profile.ts",
		documented: true,
		doc: "docs/grok-bot.md",
		policy: {
			safe: "shadow",
			enforcing: "enforce",
			step: "set SUBSTRATE_BRIEF_PROFILE=enforce in the unit env and restart substrate-mcp; callers may still pass profile=full",
			rollback: "set SUBSTRATE_BRIEF_PROFILE=shadow (or off) and restart; cached entries need no flush",
			evidence: [
				{
					id: "bytes saved per brief",
					stat: "ratio",
					numerator: { series: "brief.profile_bytes_saved" },
					denominator: { series: "brief.p95" },
					comparator: ">=",
					threshold: 700,
					unit: "bytes/brief",
					minSamples: 30,
					window: "3d",
					needs: "extended",
					rationale:
						"PROPOSED. 700 bytes is 20 % of the 3500-byte compact cap (DEFAULT_COMPACT_BYTES): below it the compact rendering saves too little to change what a surface is served. The history carries no full-size series, so the recon's 20 % share cannot be computed; bytes per brief replaces it. The denominator counts every brief of every surface, and bytes saved accrue only on fresh answers, so the figure is diluted and a ready verdict is conservative.",
					proposed: true,
				},
			],
		},
	},
	{ name: "SUBSTRATE_BRIEF_PROFILE_SURFACES", kind: "list", plane: "brief", default: "grok-bot,grok-build", allowed: "comma or space separated known surfaces", unset: "grok-bot and grok-build; unknown names are ignored with a boot warning", readBy: "mcp-server/brief-profile.ts", documented: true, doc: "docs/grok-bot.md" },
	{ name: "SUBSTRATE_BRIEF_COMPACT_NODES", kind: "number", plane: "brief", default: "12", allowed: "1..200 (clamped)", unset: "12", readBy: "mcp-server/brief-profile.ts", documented: true, doc: "docs/grok-bot.md" },
	{ name: "SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS", kind: "number", plane: "brief", default: "240", allowed: "40..4000 (clamped)", unset: "240", readBy: "mcp-server/brief-profile.ts", documented: true, doc: "docs/grok-bot.md" },
	{ name: "SUBSTRATE_BRIEF_COMPACT_BYTES", kind: "number", plane: "brief", default: "3500", allowed: "512..65536 (clamped)", unset: "3500 bytes", readBy: "mcp-server/brief-profile.ts", documented: true, doc: "docs/grok-bot.md" },
	{ name: "SUBSTRATE_SERVED_TOKENS_PER_HOUR", kind: "number", plane: "brief", default: "none", allowed: "tokens per rolling hour", unset: "the served.tokens_est rows of /slo report unconfigured and are never judged", readBy: "observability/slo.ts", documented: true, doc: "docs/observability.md" },
	{
		name: "SUBSTRATE_BRIEF_RECALL",
		kind: "mode",
		plane: "brief",
		default: "off",
		allowed: "off | shadow | enforce",
		unset: "off: no prefetcher, no Hindsight traffic, every brief and ETag as before; an unknown value is off with a boot warning",
		readBy: "mcp-server/recall-snapshot.ts",
		documented: true,
		doc: "docs/data-planes.md",
		policy: {
			safe: "off",
			enforcing: "enforce",
			step: "off to shadow: set SUBSTRATE_BRIEF_RECALL=shadow and restart, soak at least three days; then, if the advisor says ready, set SUBSTRATE_BRIEF_RECALL=enforce and restart (needs the cache)",
			rollback: "set SUBSTRATE_BRIEF_RECALL=off and restart",
			evidence: [
				{
					id: "would-include share of briefs",
					stat: "share",
					numerator: { series: "brief.recall", labels: ["would_include", "included"] },
					comparator: ">=",
					threshold: 0.5,
					unit: "share",
					minSamples: 100,
					window: "3d",
					needs: "extended",
					rationale: "PROPOSED. Fewer than half of briefs finding a fresh recall snapshot means enforce would mostly add nothing. Denominator is every brief counted in brief.recall, including disabled and dropped_by_cap.",
					proposed: true,
				},
				{
					id: "cold plus stale share of briefs",
					stat: "share",
					numerator: { series: "brief.recall", labels: ["cold", "stale"] },
					comparator: "<",
					threshold: 0.3,
					unit: "share",
					minSamples: 100,
					window: "3d",
					needs: "extended",
					rationale: "PROPOSED. A cold or stale snapshot is counted and omitted; 30 % or more of briefs missing means the prefetch interval or budget is wrong for the traffic.",
					proposed: true,
				},
				{
					id: "prefetch error share",
					stat: "share",
					numerator: { series: "recall.prefetch", labels: ["error"] },
					comparator: "<",
					threshold: 0.05,
					unit: "share",
					minSamples: 100,
					window: "3d",
					needs: "extended",
					rationale: "PROPOSED. Prefetch errors at 5 % or more mean the Hindsight plane is not steady enough to enforce a section built from it.",
					proposed: true,
				},
			],
			manual: "brief.p95 must not move while the mode is shadow (compare against the pre-flag week)",
		},
	},
	{ name: "SUBSTRATE_BRIEF_RECALL_INTERVAL_S", kind: "number", plane: "brief", default: "120", allowed: "30..3600", unset: "120 s", readBy: "mcp-server/recall-snapshot.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_BRIEF_RECALL_TTL_S", kind: "number", plane: "brief", default: "900", allowed: "60..86400", unset: "900 s", readBy: "mcp-server/recall-snapshot.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_BRIEF_RECALL_BUDGET_MS", kind: "number", plane: "brief", default: "1500", allowed: "100..10000", unset: "1500 ms", readBy: "mcp-server/recall-snapshot.ts", documented: true, doc: "docs/data-planes.md" },

	// ── recall (Hindsight) ────────────────────────────────────────────────────
	{ name: "HINDSIGHT_URL", kind: "secret-ref", plane: "recall", default: "none", allowed: "Hindsight base URL", unset: "no recall plane: memory_search skips Hindsight, retain is not forwarded", readBy: "mcp-server/planes/hindsight.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_API_KEY", kind: "secret-ref", plane: "recall", default: "none", allowed: "API key", unset: "no recall plane", readBy: "mcp-server/planes/hindsight.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_BANK_PREFIX", kind: "string", plane: "recall", default: "sub-", allowed: "bank name prefix", unset: "sub-", readBy: "mcp-server/planes/hindsight.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_BANKS", kind: "list", plane: "recall", default: "none", allowed: "comma separated bank names", unset: "recall reads the caller's own bank only", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_BANK", kind: "string", plane: "recall", default: "none", allowed: "legacy", unset: "nothing: set or not, it is unread and only triggers a boot warning", readBy: "mcp-server/config.ts, legacy-env.ts", documented: false, status: "legacy", doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_RECALL_BUDGET_MS", kind: "number", plane: "recall", default: "4000", allowed: "positive integer ms", unset: "4000 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_SEARCH_RECALL_BUDGET_MS", kind: "number", plane: "recall", default: "1500", allowed: "positive integer ms", unset: "1500 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_RETAIN_TIMEOUT_MS", kind: "number", plane: "recall", default: "8000", allowed: "positive integer ms", unset: "8000 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_RETAIN_OUTBOX_PATH", kind: "path", plane: "recall", default: "none", allowed: "file path", unset: "memory-only retain queue", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_RETAIN_OUTBOX_MAX", kind: "number", plane: "recall", default: "10000", allowed: "positive integer", unset: "10000 entries", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_RETAIN_MAX_ATTEMPTS", kind: "number", plane: "recall", default: "10", allowed: "positive integer", unset: "10 attempts", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "SUBSTRATE_RETAIN_DRAIN_MS", kind: "number", plane: "recall", default: "30000", allowed: "positive integer ms", unset: "30000 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/data-planes.md" },
	{
		name: "SUBSTRATE_HINDSIGHT_INVENTORY",
		kind: "toggle",
		plane: "recall",
		default: "off",
		allowed: "on | off",
		unset: "off: no probes, no gauges, no /healthz hindsight block; anything else is off with a boot warning",
		readBy: "mcp-server/hindsight-inventory.ts",
		documented: true,
		doc: "docs/data-planes.md",
		policy: {
			safe: "off",
			enforcing: "on",
			step: "set SUBSTRATE_HINDSIGHT_INVENTORY=on in the unit env and restart; the inventory is read-only against Hindsight",
			rollback: "set SUBSTRATE_HINDSIGHT_INVENTORY=off and restart",
			evidence: [],
			manual: "substrate.hindsight.bank.* gauges (facts, pending_operations, failed_operations, last_write_age_seconds) appear in /metrics under gauges only, never in the history, and /healthz.hindsight carries the drift report",
		},
	},
	{ name: "SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S", kind: "number", plane: "recall", default: "60", allowed: "30..3600", unset: "60 s", readBy: "mcp-server/hindsight-inventory.ts", documented: true, doc: "docs/data-planes.md" },
	{ name: "HINDSIGHT_MENTAL_MODELS", kind: "list", plane: "recall", default: "none", allowed: "bank=id[,id...] entries separated by semicolon; bank must be in HINDSIGHT_BANKS; id matches A-Za-z0-9_- up to 80 characters; at most 20 models", unset: "no weekly refresh; no timer starts", readBy: "mcp-server/config.ts", documented: false, doc: "docs/memory-governance.md" },

	// ── docs (RAGFlow) ────────────────────────────────────────────────────────
	{ name: "RAGFLOW_URL", kind: "string", plane: "docs", default: "none", allowed: "RAGFlow base URL", unset: "docs_search answers degraded, docs_ingest refuses", readBy: "mcp-server/planes/ragflow.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "RAGFLOW_API_KEY", kind: "secret-ref", plane: "docs", default: "none", allowed: "API key", unset: "the plane is unconfigured", readBy: "mcp-server/planes/ragflow.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "RAGFLOW_DATASET_ID", kind: "string", plane: "docs", default: "none", allowed: "dataset id", unset: "nothing: no code reads it today (docs_ingest names the dataset after the repo)", readBy: "none", documented: true, status: "unread", doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_INGEST_ROOTS", kind: "list", plane: "docs", default: "docs/, README.md, .planning/PROJECT.md", allowed: "comma separated path prefixes", unset: "the default roots", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_VM_GUEST", kind: "toggle", plane: "docs", default: "off", allowed: "1", unset: "docs_ingest is allowed; 1 refuses it before any network call", readBy: "mcp-server/config.ts, cli/index.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_STATE_FILE", kind: "path", plane: "docs", default: "none", allowed: "file path", unset: "ingest records and version pins stay process-local", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{
		name: "SUBSTRATE_DOCS_PRUNE_SUPERSEDED",
		kind: "toggle",
		plane: "docs",
		default: "off",
		allowed: "1",
		unset: "off: every superseded document stays on the plane",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/docs-search-ingest.md",
		policy: {
			safe: "unset",
			enforcing: "1",
			step: "set SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1 in the unit env and restart; a failed delete is logged and recorded, never a refusal",
			rollback: "unset it and restart; documents already deleted from RAGFlow are not restored (re-ingest)",
			evidence: [],
			manual: "the docs_ingest result records pruned and failed per call, and /slo.docs freshness stays within SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H",
		},
	},
	{ name: "SUBSTRATE_DOCS_SIMILARITY_THRESHOLD", kind: "number", plane: "docs", default: "0.2", allowed: "[0, 1]", unset: "0.2", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_VECTOR_WEIGHT", kind: "number", plane: "docs", default: "0.3", allowed: "[0, 1]", unset: "0.3", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_TOP_K", kind: "number", plane: "docs", default: "1024", allowed: "positive integer", unset: "1024", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_SEARCH_BUDGET_MS", kind: "number", plane: "docs", default: "4000", allowed: "0 = no shared deadline", unset: "4000 ms", readBy: "mcp-server/config.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H", kind: "number", plane: "docs", default: "168", allowed: "0..8760 (0 reports without judging)", unset: "168 hours", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_DOCS_TRIGGER_LAG_MIN", kind: "number", plane: "docs", default: "15", allowed: "0..10080 (0 stops recording)", unset: "15 minutes", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_DOCS_LAG_CHECK_S", kind: "number", plane: "docs", default: "60", allowed: "15..3600", unset: "60 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_DOCS_CANARY", kind: "toggle", plane: "docs", default: "off", allowed: "1", unset: "the live golden canary refuses to run", readBy: "scripts/docs-golden.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_CANARY_MANIFEST", kind: "path", plane: "docs", default: "none", allowed: "JSON file with sha256 and dataset_commit", unset: "the live canary refuses to run", readBy: "scripts/docs-golden.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_CANARY_STATE", kind: "path", plane: "docs", default: "/var/lib/substrate/docs-canary-last.json", allowed: "file path", unset: "the default state file", readBy: "scripts/docs-golden.ts", documented: true, doc: "docs/docs-search-ingest.md" },
	{ name: "SUBSTRATE_DOCS_TIMEOUT_MS", kind: "number", plane: "docs", default: "180000", allowed: "positive ms", unset: "180000 ms (the CLI's docs ingest and merge-trigger calls)", readBy: "cli/docs.ts", documented: true, doc: "docs/docs-search-ingest.md" },

	// ── admission ─────────────────────────────────────────────────────────────
	{
		name: "SUBSTRATE_BUDGETS",
		kind: "mode",
		plane: "admission",
		default: "shadow",
		allowed: "off | shadow | enforce",
		unset: "shadow: decide and count, never refuse; anything else is shadow",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/observability.md",
		policy: {
			safe: "shadow",
			enforcing: "enforce",
			step: "set SUBSTRATE_BUDGETS=enforce in the unit env and restart substrate-mcp",
			rollback: "set SUBSTRATE_BUDGETS=shadow and restart",
			evidence: [
				{
					id: "shadow-limited share of decisions",
					stat: "share",
					numerator: { series: "admission.decisions", labels: ["shadow_limited", "limited"] },
					denominator: { series: "admission.decisions", labels: ["allowed", "shadow_limited", "limited"] },
					comparator: "<=",
					threshold: 0.01,
					unit: "share",
					minSamples: 100,
					window: "24h",
					needs: "core",
					rationale:
						"PROPOSED. The 1 % ceiling and the 100-decision floor are the ones ADMISSION_SLO already uses for admission.limited_rate; the proposal is to apply them to the SHADOW count, because that row reads 0 in shadow by design. A bypass is not a decision and is left out. The history is aggregated over surfaces and classes: the per-surface-and-class check and the zero tolerance for the coordination class need /metrics substrate.admission.decisions.",
					proposed: true,
				},
			],
			manual: "per surface and class shadow-limited counts from /metrics (substrate.admission.decisions); none for coordination",
		},
	},
	{ name: "SUBSTRATE_BUDGET_ANONYMOUS_RPS", kind: "number", plane: "admission", default: "2", allowed: "positive number", unset: "2", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BUDGET_ANONYMOUS_BURST", kind: "number", plane: "admission", default: "4", allowed: "positive integer", unset: "4", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BREAKER", kind: "toggle", plane: "admission", default: "on", allowed: "0 | false | no turns every breaker off", unset: "breakers on", readBy: "observability/breaker.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BREAKER_FAILURES", kind: "number", plane: "admission", default: "5", allowed: "1..100", unset: "5", readBy: "observability/breaker.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BREAKER_OPEN_MS", kind: "number", plane: "admission", default: "30000", allowed: "1000..600000", unset: "30000 ms", readBy: "observability/breaker.ts", documented: true, doc: "docs/observability.md" },

	// ── observability ─────────────────────────────────────────────────────────
	{ name: "OTEL_EXPORTER_OTLP_ENDPOINT", kind: "string", plane: "observability", default: "none", allowed: "OTLP/HTTP base URL", unset: "export is off", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", kind: "string", plane: "observability", default: "the generic endpoint", allowed: "URL", unset: "the generic endpoint", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", kind: "string", plane: "observability", default: "the generic endpoint", allowed: "URL", unset: "the generic endpoint", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_EXPORTER_OTLP_HEADERS", kind: "secret-ref", plane: "observability", default: "none", allowed: "key=value list", unset: "no export headers; the value may carry a token and is never printed", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_EXPORTER_OTLP_TIMEOUT", kind: "number", plane: "observability", default: "5000", allowed: ">= 100 ms", unset: "5000 ms", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_SERVICE_NAME", kind: "string", plane: "observability", default: "substrate-mcp", allowed: "service name", unset: "substrate-mcp", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "OTEL_RESOURCE_ATTRIBUTES", kind: "string", plane: "observability", default: "none", allowed: "key=value list", unset: "no extra resource attributes", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_OTLP_INTERVAL_MS", kind: "number", plane: "observability", default: "30000", allowed: ">= 1000 ms", unset: "30000 ms", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_TRACE_SAMPLE_RATIO", kind: "number", plane: "observability", default: "1", allowed: "0..1", unset: "1 (every trace)", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_TRACE_BUFFER", kind: "number", plane: "observability", default: "2048", allowed: ">= 16 spans", unset: "2048", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_INSTANCE_ID", kind: "string", plane: "observability", default: "the hostname", allowed: "instance id", unset: "the hostname", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_ENV", kind: "string", plane: "observability", default: "none", allowed: "deployment environment name", unset: "no deployment.environment attribute", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_BRIEF_P95_MS", kind: "number", plane: "observability", default: "800", allowed: "a brief histogram bucket bound", unset: "800 ms", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_EMIT_SUCCESS", kind: "number", plane: "observability", default: "0.995", allowed: "ratio", unset: "0.995", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_LEASE_STEAL", kind: "number", plane: "observability", default: "0.005", allowed: "ratio", unset: "0.005 (provisional)", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_QUARANTINE", kind: "number", plane: "observability", default: "0.01", allowed: "ratio", unset: "0.01 (provisional)", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_MIN_SAMPLES", kind: "number", plane: "observability", default: "20", allowed: "count", unset: "20", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_PLANE_AVAILABILITY", kind: "number", plane: "observability", default: "0.99", allowed: "ratio", unset: "0.99", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_DOCS_SEARCH_P95_MS", kind: "number", plane: "observability", default: "2000", allowed: "a docs histogram bucket bound", unset: "2000 ms", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_RUNWAY_DAYS", kind: "number", plane: "observability", default: "14", allowed: "days", unset: "14 days", readBy: "observability/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_CHECKPOINT", kind: "path", plane: "observability", default: "/var/lib/substrate/slo-checkpoint.json when /var/lib/substrate exists", allowed: "absolute path | off", unset: "the default path when its directory exists, else no checkpoint; a relative value is rejected with a boot warning", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_CHECKPOINT_S", kind: "number", plane: "observability", default: "60", allowed: "0..86400 (0 writes only at shutdown)", unset: "60 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{
		name: "SUBSTRATE_SLO_NOTIFY",
		kind: "toggle",
		plane: "observability",
		default: "off",
		allowed: "1",
		unset: "off: no transition notifier",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/observability.md",
		policy: {
			safe: "unset",
			enforcing: "1",
			step: "set SUBSTRATE_SLO_NOTIFY=1 in the unit env and restart; it emits one warning or note per sustained SLO transition",
			rollback: "unset it and restart",
			evidence: [],
			manual: "transition events on the ledger (surface substrate, payload.runtime=slo) are the output; read /slo for the verdicts they announce",
		},
	},
	{ name: "SUBSTRATE_SLO_NOTIFY_S", kind: "number", plane: "observability", default: "60", allowed: "5..86400", unset: "60 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_NOTIFY_SUSTAIN_S", kind: "number", plane: "observability", default: "300", allowed: "0..86400 (0 announces at once)", unset: "300 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_SLO_WEBHOOK_URL", kind: "secret-ref", plane: "observability", default: "none", allowed: "http(s) URL", unset: "no webhook; the URL may carry a token and is never printed", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BURN_TOKENS_PER_HOUR", kind: "number", plane: "observability", default: "none", allowed: "tokens per rolling hour", unset: "the burn.tokens row is unconfigured and never judged", readBy: "observability/burn.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_BURN_COST_USD_PER_HOUR", kind: "number", plane: "observability", default: "none", allowed: "USD per rolling hour", unset: "the burn.cost_usd row is unconfigured and never judged", readBy: "observability/burn.ts", documented: true, doc: "docs/observability.md" },
	{
		name: "SUBSTRATE_METRICS_HISTORY",
		kind: "toggle",
		plane: "observability",
		default: "off",
		allowed: "on | off",
		unset: "off: no sampler, no table, GET /slo/history answers 404; it also needs a ledger",
		readBy: "mcp-server/config.ts",
		documented: true,
		doc: "docs/observability.md",
		policy: {
			safe: "off",
			enforcing: "on",
			step: "decide the Greptime volume first (500 MB is recorded in one place and 5 GB in the plan), then set SUBSTRATE_METRICS_HISTORY=on in the unit env and restart; it is the enabler for every history-based criterion",
			rollback: "set SUBSTRATE_METRICS_HISTORY=off and restart; the table stays and its rows expire on the TTL",
			evidence: [],
			manual: "none: this flag is what makes the advisor's evidence exist; before it is on every criterion reads series-unavailable",
		},
	},
	{ name: "SUBSTRATE_METRICS_HISTORY_INTERVAL_S", kind: "number", plane: "observability", default: "60", allowed: "15..3600", unset: "60 s", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_METRICS_HISTORY_TTL", kind: "string", plane: "observability", default: "14d", allowed: "1d..90d whole days", unset: "14d; applied when the table is created", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" },
	{ name: "SUBSTRATE_METRICS_HISTORY_SERIES", kind: "mode", plane: "observability", default: "core", allowed: "core | extended (any case, trimmed; anything else is core and is named at boot)", unset: "core: the 11 core series, sampler and readback unchanged", readBy: "mcp-server/config.ts", documented: true, doc: "docs/dashboards.md" },

	// ── vps ───────────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_DOCTOR_EMIT", kind: "toggle", plane: "vps", default: "off", allowed: "1", unset: "doctor --emit only prints a hint", readBy: "scripts/doctor-runtime.ts", documented: true, doc: "docs/runbooks/production-parity.md" },
	{ name: "SUBSTRATE_DOCTOR_STATE", kind: "path", plane: "vps", default: "/var/lib/substrate/doctor-last.json", allowed: "file path", unset: "the default dedupe record", readBy: "scripts/doctor-runtime.ts", documented: true, doc: "docs/runbooks/production-parity.md" },
	{ name: "SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S", kind: "number", plane: "vps", default: "0", allowed: "non-negative", unset: "0: any page moving in the one-second sample is drift", readBy: "scripts/doctor-runtime.ts", documented: true, doc: "docs/runbooks/production-parity.md" },
	{ name: "SUBSTRATE_EXPOSURE_MAX", kind: "number", plane: "vps", default: "none", allowed: "0..10 (a number; anything else is one warn row and the rows stay report-only)", unset: "report only: the doctor prints each unit's systemd-analyze exposure and never changes its exit code", readBy: "scripts/doctor-sandbox.ts", documented: true, doc: "docs/runbooks/vps-hardening.md" },
	{ name: "SUBSTRATE_DEPLOY_PREFLIGHT", kind: "mode", plane: "vps", default: "report", allowed: "off | report | enforce", unset: "report: deploy-release.sh prints the preflight table on stderr and always continues", readBy: "infra/vps/deploy-release.sh", documented: false, status: "shell", doc: "infra/vps/README.md" },
	{ name: "SUBSTRATE_DEPLOY_GATE", kind: "mode", plane: "vps", default: "off", allowed: "off | report | enforce", unset: "off: deploy-release.sh does not run the boot-and-prove gate", readBy: "infra/vps/deploy-release.sh", documented: false, status: "shell", doc: "docs/runbooks/release-gate.md" },
	{
		name: "SUBSTRATE_WATCHDOG",
		kind: "toggle",
		plane: "vps",
		default: "off",
		allowed: "1 (only the literal 1)",
		unset: "off: no READY or WATCHDOG notifications",
		readBy: "mcp-server/watchdog.ts",
		documented: true,
		doc: "docs/runbooks/disk-pressure.md",
		policy: {
			safe: "unset",
			enforcing: "1",
			step: "install infra/vps/substrate-mcp.service.d/20-watchdog.conf.example as the drop-in (it sets Type=notify and SUBSTRATE_WATCHDOG=1 together), then restart; Type=notify with the flag off blocks startup",
			rollback: "remove the drop-in and restart",
			evidence: [],
			manual: "bun run doctor:runtime rows for the unit and GET /livez answering",
		},
	},
	{ name: "SUBSTRATE_WATCHDOG_LAG_MS", kind: "number", plane: "vps", default: "5000", allowed: "100..60000", unset: "5000 ms", readBy: "mcp-server/watchdog.ts", documented: true },
	{ name: "SUBSTRATE_WATCHDOG_PROBE_MS", kind: "number", plane: "vps", default: "2000", allowed: "100..60000", unset: "2000 ms", readBy: "mcp-server/watchdog.ts", documented: true },
	{ name: "SUBSTRATE_WATCHDOG_NOTIFY_MS", kind: "number", plane: "vps", default: "3000", allowed: "100..60000", unset: "3000 ms", readBy: "mcp-server/watchdog.ts", documented: true },
	{ name: "SUBSTRATE_ALERT_WAIT_S", kind: "number", plane: "vps", default: "60", allowed: "0..60 (0 posts at once)", unset: "60 s", readBy: "scripts/substrate-alert.ts", documented: true },
	{ name: "SUBSTRATE_RETAIN_RELEASE_MAX_GB", kind: "number", plane: "vps", default: "6", allowed: "non-negative (0 disables the compare)", unset: "6 GB", readBy: "scripts/doctor-vps.ts", documented: true },
	{ name: "SUBSTRATE_STATE_MAX_GB", kind: "number", plane: "vps", default: "1", allowed: "non-negative (0 disables the compare)", unset: "1 GB", readBy: "scripts/doctor-vps.ts", documented: true },
	{ name: "SUBSTRATE_JOURNAL_MAX_MB", kind: "number", plane: "vps", default: "400", allowed: "non-negative (0 disables the compare)", unset: "400 MB", readBy: "scripts/doctor-vps.ts", documented: true },
	{ name: "SUBSTRATE_DEPLOY_MIN_FREE_GB", kind: "number", plane: "vps", default: "5", allowed: "0..9999 whole gigabytes (0 disables the gate)", unset: "5 GB", readBy: "mcp-server/index-run.ts, ledger-run.ts, scripts/doctor-runtime.ts, scripts/deploy-preflight.ts, infra/vps/deploy-release.sh (set in the shell that runs the script; the preflight and the gate inherit it)", documented: true, doc: "docs/runbooks/disk-pressure.md" },
	{ name: "SUBSTRATE_REPO", kind: "path", plane: "vps", default: "the checkout of this script", allowed: "absolute path", unset: "the repo the script lives in", readBy: "scripts/parity-check.ts", documented: true, doc: "docs/runbooks/production-parity.md" },
	{ name: "SUBSTRATE_SKILLS_LIBRARY", kind: "path", plane: "vps", default: "/root/agent-skills", allowed: "absolute path to the library checkout", unset: "/root/agent-skills", readBy: "scripts/skills-doctor.ts", documented: false, doc: "docs/skills-plane.md" },
	{ name: "SUBSTRATE_SKILLS_BRIDGE_ENV", kind: "path", plane: "vps", default: "/etc/substrate/substrate-bridge.env", allowed: "absolute path to the bridge env file", unset: "/etc/substrate/substrate-bridge.env", readBy: "scripts/skills-doctor.ts", documented: false, doc: "docs/skills-plane.md" },

	// ── host ──────────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_HOST_ROUTE", kind: "string", plane: "host", default: "none", allowed: "route from the 03-01 spike", unset: "the host refuses to start", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_TESTS_ROUTE", kind: "string", plane: "host", default: "none", allowed: "route from the 03-01 spike", unset: "the host refuses to start", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_HOST_MODEL", kind: "string", plane: "host", default: "grok-4.6", allowed: "model id", unset: "grok-4.6", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_HOST_PORT", kind: "number", plane: "host", default: "7411", allowed: "port", unset: "7411", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_HOST_API_TOKEN", kind: "secret-ref", plane: "host", default: "none", allowed: "bearer token for the host task API (value never logged)", unset: "the host refuses to start", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_SANDBOX_NET", kind: "mode", plane: "host", default: "published_loopback", allowed: "published_loopback | internal", unset: "published_loopback; any other value refuses to start", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_SANDBOX_HOSTFN", kind: "string", plane: "host", default: "sandbox", allowed: "collection name", unset: "sandbox", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_SANDBOX_EGRESS", kind: "list", plane: "host", default: "none (deny-all)", allowed: "comma separated host:port", unset: "deny-all; a malformed entry refuses naming it", readBy: "host/sandbox-options.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_SANDBOX_STATE", kind: "path", plane: "host", default: "<storage root>/sandboxes.json", allowed: "file path", unset: "under RIVETKIT_STORAGE_PATH", readBy: "host/sandbox-provider.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_MCP_URL", kind: "string", plane: "host", default: "http://127.0.0.1:7410/mcp", allowed: "URL", unset: "the loopback MCP endpoint", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_ENGINE_ENDPOINT", kind: "string", plane: "host", default: "http://127.0.0.1:6420", allowed: "URL", unset: "the loopback engine endpoint", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "RIVET_RUN_ENGINE", kind: "toggle", plane: "host", default: "off (share mode)", allowed: "1 is REFUSED until the G2 verdict; leave unset", unset: "the host runs in shared-engine mode (UNVERIFIED); the literal 1 makes it refuse to boot until 31-SPIKE.md records the G2 verdict", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "RIVET_RUN_ENGINE_HOST", kind: "string", plane: "host", default: "127.0.0.1", allowed: "host", unset: "127.0.0.1", readBy: "host/main.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_APPROVAL_TIMEOUT_S", kind: "number", plane: "host", default: "900", allowed: "positive seconds", unset: "900 s; a malformed value logs and uses the default", readBy: "host/tasks.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_APPROVAL_BOT_TOKEN", kind: "secret-ref", plane: "host", default: "none", allowed: "Telegram bot token", unset: "no Telegram approvals", readBy: "host/telegram.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_APPROVAL_CHAT_ID", kind: "string", plane: "host", default: "none", allowed: "chat id", unset: "no Telegram approvals", readBy: "host/telegram.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_APPROVAL_USER_IDS", kind: "list", plane: "host", default: "none", allowed: "comma separated user ids", unset: "no user may approve", readBy: "host/telegram.ts", documented: true, doc: "docs/runbooks/lane-a-host.md" },
	{ name: "SUBSTRATE_CHECKOUT", kind: "path", plane: "host", default: "the repo the host runs from", allowed: "absolute path", unset: "the repo checkout", readBy: "host/main.ts", documented: true },
	{ name: "SUBSTRATE_SKILLS_DIR", kind: "path", plane: "host", default: "the ultrathink plugin skills directory", allowed: "directory", unset: "the built-in directory", readBy: "host/main.ts", documented: true },
	{ name: "SUBSTRATE_LIBRARY_DIR", kind: "path", plane: "host", default: "/root/agent-skills", allowed: "git checkout", unset: "/root/agent-skills", readBy: "host/main.ts", documented: true },
	{ name: "SUBSTRATE_SKILL_MOUNTS", kind: "mode", plane: "host", default: "nested", allowed: "mount route from the 04-01 spike", unset: "nested", readBy: "host/main.ts", documented: true },
	{ name: "SUBSTRATE_ULTRATHINK_CONFIG", kind: "path", plane: "host", default: "/root/.config/ultrathink/config.json", allowed: "file path", unset: "the default config", readBy: "host/main.ts", documented: true },
	{ name: "SUBSTRATE_ULTRATHINK_MCP", kind: "path", plane: "host", default: "the ultrathink plugin binary", allowed: "binary", unset: "the built-in path", readBy: "host/mcp-proxy.ts", documented: true },
	{ name: "SUBSTRATE_VM_ANTHROPIC_API_KEY", kind: "secret-ref", plane: "host", default: "none", allowed: "API key", unset: "read only when the route is anthropic_key", readBy: "host/main.ts", documented: true },
	{ name: "RIVETKIT_STORAGE_PATH", kind: "path", plane: "host", default: "/var/lib/substrate/agentos", allowed: "directory", unset: "/var/lib/substrate/agentos", readBy: "host/main.ts, audit.ts", documented: true },

	// ── clients ───────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_TIMEOUT_MS", kind: "number", plane: "clients", default: "1500", allowed: "positive ms", unset: "1500 ms (the CLI's lessons calls)", readBy: "cli/index.ts", documented: true },
	{ name: "SUBSTRATE_SKILLS_TIMEOUT_MS", kind: "number", plane: "clients", default: "180000", allowed: "positive ms", unset: "180000 ms (the CLI's skills calls)", readBy: "cli/skills.ts", documented: true },
	{ name: "SUBSTRATE_CLI", kind: "path", plane: "clients", default: "the CLI entry in the checkout", allowed: "path", unset: "the built-in path", readBy: "projector/cursor.ts", documented: true },
	{ name: "SUBSTRATE_CURSOR_ROOT", kind: "path", plane: "clients", default: "/root/.cursor", allowed: "directory", unset: "/root/.cursor", readBy: "collectors/cursor-stop.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_CURSOR_STOP", kind: "path", plane: "clients", default: "the stop hook in the checkout", allowed: "path", unset: "the built-in path", readBy: "projector/cursor.ts", documented: true },
	{ name: "SUBSTRATE_TRANSCRIPTS_DIR", kind: "path", plane: "clients", default: "/var/lib/substrate/transcripts/cursor", allowed: "directory", unset: "the default directory", readBy: "collectors/cursor-stop.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_COLLECTOR_STATE", kind: "path", plane: "clients", default: "/var/lib/substrate/herdr-offsets.json (herdr) or the muse state file", allowed: "file path", unset: "each collector's own default", readBy: "collectors/herdr-state.ts, muse.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_STATE_DIR", kind: "path", plane: "clients", default: "/var/lib/substrate", allowed: "directory", unset: "/var/lib/substrate", readBy: "collectors/emit.ts, muse.ts, projector/muse.ts", documented: true, doc: "docs/collectors.md" },
	{
		name: "SUBSTRATE_EVENT_SPOOL",
		kind: "toggle",
		plane: "clients",
		default: "off",
		allowed: "off | on",
		unset: "off: a failed event is dropped and counted as before and no spool file is touched",
		readBy: "collectors/spool.ts, collectors/emit.ts",
		documented: true,
		doc: "docs/collectors.md",
		policy: {
			safe: "off",
			enforcing: "on",
			step: "first confirm the server reports idempotency accept (or enforce) on /healthz, then set SUBSTRATE_EVENT_SPOOL=on in one collector's env file and restart it; the client refuses to replay against a server that does not",
			rollback: "set off; the spool file is inert and is never read while off",
			evidence: [],
			manual: "substrate spool status shows depth returning to 0 after an outage, and dropped lines in refused-emits.jsonl stay at 0",
		},
	},
	{ name: "SUBSTRATE_EVENT_SPOOL_MAX", kind: "number", plane: "clients", default: "5000", allowed: "1..100000 (not a positive integer: the default; above the ceiling: clamped to it; each with one stderr warning)", unset: "5000 parked lines; over it the oldest is dropped with a visible line", readBy: "collectors/spool.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_EVENT_SPOOL_MAX_BYTES", kind: "number", plane: "clients", default: "8388608", allowed: "1024..64 MiB (not a positive integer: the default; below 1024: raised to 1024; above the ceiling: clamped; each with one stderr warning)", unset: "8 MiB spool file", readBy: "collectors/spool.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_EVENT_SPOOL_TTL_H", kind: "number", plane: "clients", default: "48", allowed: "1..720 whole hours (not a positive integer: the default; above the ceiling: clamped; each with one stderr warning)", unset: "48 h before an unsent event is dropped with a visible line", readBy: "collectors/spool.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS", kind: "number", plane: "clients", default: "12", allowed: "1..100 (not a positive integer: the default; above the ceiling: clamped; each with one stderr warning)", unset: "12 delivery attempts per event, the live one included", readBy: "collectors/spool.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_REFUSED_EMITS_MAX_BYTES", kind: "number", plane: "clients", default: "1048576", allowed: "4096..64 MiB (not a positive integer: the default; below 4096: raised to 4096; above the ceiling: clamped; each with one stderr warning)", unset: "refused-emits.jsonl rotates to a single .1 file at 1 MiB", readBy: "collectors/emit.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_MUSE_REPOS", kind: "list", plane: "clients", default: "none", allowed: "colon separated absolute roots", unset: "the muse collector refuses: there is no inferred default", readBy: "collectors/muse.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "SUBSTRATE_MUSE_TOKEN_FILE", kind: "path", plane: "clients", default: "/etc/substrate/substrate-collector-muse.env", allowed: "file path", unset: "the default token file", readBy: "projector/muse.ts", documented: true },
	{ name: "MUSE_BIN", kind: "path", plane: "clients", default: "/root/.local/bin/muse", allowed: "binary", unset: "the default install path", readBy: "projector/muse.ts", documented: true },
	{ name: "MUSE_PLUGIN_DIR", kind: "path", plane: "clients", default: "/var/lib/substrate/muse-plugin", allowed: "directory", unset: "the default bundle directory", readBy: "projector/muse.ts", documented: true },
	{ name: "SUBSTRATE_BUN_BIN", kind: "path", plane: "clients", default: "the reflex bun install", allowed: "binary", unset: "the built-in path", readBy: "projector/muse.ts", documented: true },
	{ name: "SUBSTRATE_OMP_PENDING_DIR", kind: "path", plane: "clients", default: "/root/.omp/agent/substrate-pending", allowed: "directory", unset: "the default directory", readBy: "projector/omp/substrate-skills.ts", documented: true },
	{ name: "GROK_SESSIONS_DIR", kind: "path", plane: "clients", default: "$HOME/.grok/sessions", allowed: "directory", unset: "the default under HOME", readBy: "collectors/grok.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "HERDR_SOCKET_PATH", kind: "path", plane: "clients", default: "none", allowed: "socket path", unset: "falls through to HERDR_SESSION, then the default socket", readBy: "collectors/herdr.ts", documented: true, doc: "docs/collectors.md" },
	{ name: "HERDR_SESSION", kind: "string", plane: "clients", default: "none", allowed: "session name", unset: "the default socket under HOME", readBy: "collectors/herdr.ts", documented: true, doc: "docs/collectors.md" },

	// ── harness ───────────────────────────────────────────────────────────────
	{ name: "SUBSTRATE_TEST_PG_URL", kind: "secret-ref", plane: "harness", default: "none", allowed: "scratch postgres URL", unset: "the live index tests are skipped", readBy: "scripts/verify.ts, mirror-smoke.ts", documented: true, doc: "docs/ci.md" },
	{ name: "SUBSTRATE_SMOKE_REPO", kind: "string", plane: "harness", default: "swcstudiospace/agent-substrate", allowed: "owner/repo", unset: "the default repo", readBy: "scripts/grok-connector-smoke.ts", documented: true, doc: "docs/grok-bot.md" },
	{ name: "SUBSTRATE_REHEARSAL_OPERATOR_TOKEN", kind: "secret-ref", plane: "harness", default: "none", allowed: "harness-minted token", unset: "the dependent smoke falls back to SUBSTRATE_TOKEN", readBy: "scripts/rehearsal.ts, skills-propose-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_PG_IMAGE", kind: "string", plane: "harness", default: "postgres:16", allowed: "image reference", unset: "postgres:16", readBy: "scripts/rehearsal.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_SKILLS_GH_STATE", kind: "path", plane: "harness", default: "none", allowed: "harness-owned", unset: "the skills smokes refuse to run", readBy: "scripts/skills-sync-smoke.ts, skills-propose-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_SKILLS_ORIGIN", kind: "path", plane: "harness", default: "none", allowed: "harness-owned", unset: "the skills smokes refuse to run", readBy: "scripts/skills-sync-smoke.ts, skills-propose-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_SKILLS_REPO", kind: "path", plane: "harness", default: "none", allowed: "harness-owned", unset: "the skills smokes refuse to run", readBy: "scripts/skills-sync-smoke.ts, skills-propose-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_SKILLS_STATE", kind: "path", plane: "harness", default: "none", allowed: "harness-owned", unset: "the skills smokes refuse to run", readBy: "scripts/skills-sync-smoke.ts, skills-propose-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_TOKENS_DIR", kind: "path", plane: "harness", default: "none", allowed: "harness-owned", unset: "the smokes refuse to run", readBy: "scripts/desktop-smoke.ts, skills-sync-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_NAME", kind: "string", plane: "harness", default: "none", allowed: "run name the rehearsal wrote to consumer.env", unset: "empty: the run-name comparison is skipped", readBy: "scripts/docs-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_REHEARSAL_DOCS_STATE_FILE", kind: "path", plane: "harness", default: "none", allowed: "file inside the rehearsal run directory", unset: "empty: the docs state is read as absent", readBy: "scripts/docs-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_RAGFLOW_FIXTURE_URL", kind: "string", plane: "harness", default: "none", allowed: "loopback http URL of the RAGFlow stand-in", unset: "empty: the docs smoke refuses the fixture target", readBy: "packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_RAGFLOW_FIXTURE_READY", kind: "string", plane: "harness", default: "none", allowed: "1 once the stand-in answers its health probe", unset: "empty: the fixture is not marked ready", readBy: "packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_RAGFLOW_FIXTURE_PID", kind: "number", plane: "harness", default: "none", allowed: "process id of the RAGFlow stand-in", unset: "empty: the fixture pid check refuses", readBy: "packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "RAGFLOW_FIXTURE_KEY", kind: "secret-ref", plane: "harness", default: "none", allowed: "per-run scratch key, at least 32 characters", unset: "the stand-in refuses to start (exit 2)", readBy: "packages/mcp-server/src/rehearsal-ragflow-server.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "RAGFLOW_FIXTURE_PORT", kind: "number", plane: "harness", default: "none", allowed: "TCP port 1-65535", unset: "the stand-in refuses to start (exit 2)", readBy: "packages/mcp-server/src/rehearsal-ragflow-server.ts", documented: false, doc: "docs/rehearsal.md" },
	{ name: "SUBSTRATE_GATE_INDEX_DRILL", kind: "toggle", plane: "harness", default: "off", allowed: "1", unset: "off: gate:boot does not archive or restore the scratch index", readBy: "scripts/rehearsal.ts", documented: false, doc: "docs/runbooks/release-gate.md" },
	{ name: "SUBSTRATE_GATE_CHAOS_PLANES", kind: "toggle", plane: "harness", default: "off", allowed: "1", unset: "off: the rehearsal does not pause the scratch index or probe the other planes", readBy: "scripts/chaos-planes.ts", documented: false, doc: "docs/runbooks/release-gate.md" },
	{ name: "CHAOS_REHEARSAL", kind: "toggle", plane: "harness", default: "off", allowed: "1 | true | yes (case-insensitive)", unset: "the chaos smoke asserts a degraded deployment", readBy: "scripts/chaos-smoke.ts", documented: true, doc: "docs/observability.md" },
	{ name: "CHAOS_TICK_MS", kind: "number", plane: "harness", default: "2000", allowed: "ms", unset: "2000 ms", readBy: "scripts/chaos-smoke.ts", documented: true, doc: "docs/observability.md" },
	{ name: "CHAOS_TIMEOUT_MS", kind: "number", plane: "harness", default: "10000", allowed: "ms", unset: "10000 ms", readBy: "scripts/chaos-smoke.ts", documented: true, doc: "docs/observability.md" },
	{ name: "CHAOS_WINDOW_MS", kind: "number", plane: "harness", default: "60000", allowed: "ms", unset: "60000 ms", readBy: "scripts/chaos-smoke.ts", documented: true, doc: "docs/observability.md" },
	{ name: "CLAUDE_CONFIG_PATH", kind: "path", plane: "harness", default: "$HOME/.claude.json", allowed: "file path", unset: "the default under HOME", readBy: "scripts/uat-phase0.ts", documented: true, doc: "docs/uat.md" },
];

/** Every name in the registry, rows and family members. */
export function registeredNames(): ReadonlySet<string> {
	const names = new Set<string>();
	for (const flag of FLAGS) names.add(flag.name);
	for (const family of FLAG_FAMILIES) for (const member of family.members) names.add(member);
	return names;
}

/** A registry row by exact name; `Object.hasOwn`-style lookup through a Map, never `in`. */
export function flagByName(name: string): FlagSpec | undefined {
	return FLAG_INDEX.get(name);
}

const FLAG_INDEX: ReadonlyMap<string, FlagSpec> = new Map(FLAGS.map((flag) => [flag.name, flag]));

/** The flags that carry a promotion policy, in registry order. */
export function policyFlags(): FlagSpec[] {
	return FLAGS.filter((flag) => flag.policy !== undefined);
}

/**
 * The reads that have no registry row: a name that is neither a row, a family
 * member nor exempt, and a run-time-composed prefix that is neither a family
 * prefix nor exempt. This is the whole lock; the test feeds it the real tree
 * and a planted fixture.
 */
export function findUnregistered(reads: readonly EnvRead[]): EnvRead[] {
	const names = registeredNames();
	const exempt = new Set(REGISTRY_EXEMPT.map((entry) => entry.name));
	const prefixes = new Set(FLAG_FAMILIES.map((family) => family.prefix));
	return reads.filter((read) => {
		if (exempt.has(read.name)) return false;
		return read.form === "template" ? !prefixes.has(read.name) : !names.has(read.name);
	});
}
