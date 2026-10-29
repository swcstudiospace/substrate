/**
 * Where the observability and audit planes meet substrate-mcp.
 *
 * All the logic lives in `@substrate/observability` and `@substrate/audit`; this
 * file is the adapter, so the server and the service keep thin diffs and the
 * decisions stay unit-testable without a socket.
 *
 * Two things here are more than plumbing and are worth reading:
 *
 *   - `toolCallsIn` / `auditToolCalls` put the audit **in front of** the MCP
 *     dispatcher rather than inside each tool. A fail-closed tool therefore cannot
 *     run unaudited even by accident, because nothing dispatches it until the chain
 *     has taken the record.
 *   - `normalizeRoute` bounds the `route` attribute. A scanner walking random paths
 *     would otherwise mint one metric series per URL it tried.
 */
import {
	AuditLog,
	AuditUnavailableError,
	auditMode,
	auditStats,
	type ClaimDecision,
	type AuditTransport,
} from "@substrate/audit";
import {
	BurnLedger,
	CapacityRing,
	CheckpointError,
	MAX_CHECKPOINT_BYTES,
	MetricRegistry,
	OtlpExporter,
	PeriodicExporter,
	PlaneWindow,
	SPAN_KIND,
	SubstrateInstruments,
	Tracer,
	briefBySurfaceObjectives,
	evaluateBurnSlos,
	evaluateCapacitySlos,
	evaluateDocsSlos,
	evaluatePlaneSlos,
	evaluateSlos,
	loadObservabilityConfig,
	parseTraceparent,
	restoreCheckpoint,
	serializeCheckpoint,
	sloCatalogue,
	servedTokensBySurface,
	snapshotCheckpoint,
	type BurnResult,
	type CapacitySloResult,
	type ClaimOutcome,
	type MetricSnapshot,
	type NotifyRecord,
	type PlaneName,
	type PlaneSloResult,
	type SloCheckpoint,
	type SloResult,
	type SloTarget,
	type ServedTokensResult,
	type SurfaceSloResult,
	type Span,
	type SpanContext,
} from "@substrate/observability";
import { buildEvidence, devnetExplorerTxUrl, renderEvidenceHtml, type AnchorEvidence, type AnchorState, type ChainEvidence, type EvidenceBundle, type TeachableEvidence } from "@substrate/evidence";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { SubstrateConfig } from "./config.ts";
import { registerMetricsHistoryMetrics } from "./metrics-history.ts";
import { redact } from "./redact.ts";
import type { GraphTeachable, HourReport, Substrate, SubstrateObserver, VerifyOptions, VerifyVerdict } from "./service.ts";
import type { Surface } from "./types.ts";

/** Kept in step with `packages/mcp-server/package.json`. Reported as `service.version`. */
export const SUBSTRATE_VERSION = "0.1.0";

/** Routes that exist. Anything else is `other`, so the attribute stays bounded. */
const KNOWN_ROUTES = [
	"/brief",
	"/events",
	"/events/stream",
	"/verify",
	"/healthz",
	"/mcp",
	"/metrics",
	"/slo",
	"/evidence",
	"/skills/propose",
	"/skills",
	"/skills/approve",
	"/docs/search",
	"/docs/ingest",
	"/docs/merge-trigger",
	"/docs/feedback",
	"/corpus/reflect",
	"/corpus/gaps",
	"/memory/recall",
	"/slo/history",
	"/livez",
] as const;

export function normalizeRoute(pathname: string): string {
	return (KNOWN_ROUTES as readonly string[]).includes(pathname) ? pathname : "other";
}

/**
 * The claim metric's outcome, from the substrate's verdict *and* the index's action.
 *
 * A takeover of another surface's expired lease is `decision: "granted"` with the
 * index reporting `action: "stolen"`, and `stolen` is the only outcome that increments
 * `substrate.lease.steals`. Reading the verdict alone mapped every takeover to
 * `granted`, so the lease-steal rate the SLO is stated over could not leave zero no
 * matter how many leases were taken — the objective existed and the numerator did not.
 *
 * The verdict wins where the two disagree: a steal whose event never reached the ledger
 * is `revoked`, and it did not happen, so it is not a steal.
 */
export function claimOutcome(decision: ClaimDecision, action?: string): ClaimOutcome {
	if (decision === "contended") return "contended";
	if (decision === "revoked") return "revoked";
	return action === "stolen" ? "stolen" : "granted";
}

/**
 * Record a withdrawn claim as a denial on the audit chain.
 *
 * The gate in front of the dispatcher records `graph_claim` as `allowed` — which is
 * true of the *call*: it was permitted to run. What happens next is that the claim's
 * event does not reach the ledger and `claimNode` withdraws the hold. Nothing then
 * wrote that to the chain, so the audit and the per-graph evidence bundle showed the
 * claim allowed and said nothing about the withdrawal — the exact opposite of the
 * decision the substrate made, in the document an incident is reconstructed from, and
 * during the one outage this fail-closed behaviour exists for.
 *
 * Appended as its own `denied` record rather than by amending the earlier one: the
 * chain is append-only, and both records are true — the call was allowed and the hold
 * was then withdrawn. `fail-open`, because the withdrawal has already happened and
 * refusing to write it cannot undo it; the reason is on stderr either way, and a
 * failed append is counted like any other.
 *
 * Fire-and-forget, because `SubstrateObserver` is synchronous by contract: nothing in
 * it may fail the turn it is instrumenting. The returned promise is awaited only by
 * tests.
 */
export async function recordClaimWithdrawal(
	audit: AuditLog,
	instruments: SubstrateInstruments,
	sample: { surface: string; graph_id: string; node_id: string; reason: string | null; quarantineReason: string | null },
): Promise<void> {
	const written = await audit
		.append({
			surface: sample.surface,
			tool: "graph_claim",
			transport: "internal",
			decision: "denied",
			mode: "fail-open",
			graph_id: sample.graph_id,
			node_id: sample.node_id,
			reason:
				`the claim was withdrawn after it was allowed: ${sample.reason ?? sample.quarantineReason ?? "no reason given"}`,
		})
		.then((appended) => appended.written)
		.catch(() => false);
	instruments.recordAudit({ decision: "denied", written });
	if (!written) {
		process.stderr.write(
			`[substrate] withdrew claim ${sample.graph_id}/${sample.node_id} for ${sample.surface} and could not record it\n`,
		);
	}
}

/** `/slo.history` (uplift-3 N2): how far back the merged series reach, and how often they are saved. */
export interface SloHistory {
	/** Restarts so far, this process included: 1 on a fresh start, the checkpoint's epoch + 1 after a restore. */
	epoch: number;
	/** ISO time of the oldest sample the merged series reach back to. */
	since: string;
	/** ISO time of the newest checkpoint — this process's last write, else the restored file's; `null` with neither. */
	checkpointAt: string | null;
}

/** What one checkpoint write did. Never throws: a checkpoint that could not be saved is a line, not an outage. */
export interface CheckpointWrite {
	/** `false` when no path is configured or the write failed (`error` says why). */
	written: boolean;
	bytes: number;
	error: string | null;
}

export interface Observability {
	readonly instruments: SubstrateInstruments;
	readonly tracer: Tracer;
	readonly audit: AuditLog;
	readonly slos: SloTarget[];
	readonly startedAt: number;
	readonly resource: { name: string; version: string; instance: string };
	readonly exporter: PeriodicExporter | null;
	/** The observer handed to `Substrate`, so brief/emit/claim are measured. */
	readonly observer: SubstrateObserver;
	/**
	 * The last transition the notifier emitted per objective (uplift-3 N2),
	 * restored from the checkpoint and saved with it. Mutated in place by
	 * `slo-notify.ts`, read by nothing else: it exists so a restart cannot
	 * announce a breach twice.
	 */
	readonly notifyRecords: Record<string, NotifyRecord>;
	snapshot(): MetricSnapshot[];
	evaluate(): SloResult[];
	/**
	 * The per-plane availability verdicts over the rolling hour (uplift-2 R2).
	 * `configured` says which planes may be judged; the rest report `unconfigured`.
	 */
	evaluatePlanes(configured: Partial<Record<PlaneName, boolean>>): PlaneSloResult[];
	/** The docs-search latency verdict (uplift-3 N5): one row, `docs.search.p95`, beside the catalogue. */
	evaluateDocs(): SloResult[];
	/** `brief.p95` per surface (uplift-3 N7): one row per surface at or above `minSamples`, beside the catalogue. */
	evaluateBriefSurfaces(): SurfaceSloResult[];
	/** The burn verdicts over this process's ledger (restored across restarts since uplift-3 N2). Every call is a sample. */
	evaluateBurn(): BurnResult[];
	/** The capacity runway verdict (uplift-3 N2): one row, `capacity.index.runway_days`, over the `/healthz` size ring. */
	evaluateCapacity(): CapacitySloResult[];
	/** `served.tokens_est` per surface (uplift-4 S1): the estimated hourly tokens served, against `SUBSTRATE_SERVED_TOKENS_PER_HOUR`. Every call is a sample. */
	evaluateServedTokens(): ServedTokensResult[];
	history(): SloHistory;
	/**
	 * Save the checkpoint now (uplift-3 N2): the merged series, the rings and
	 * the notify map, as `<path>.part` renamed over `<path>` so a reader never
	 * sees a torn file. The periodic timer and manual triggers call this; one
	 * that arrives while a write is in flight joins it.
	 */
	checkpoint(): Promise<CheckpointWrite>;
	/**
	 * The shutdown write: waits for any write in flight, then runs one fresh
	 * write, so everything observed before the call is in the file (a joined
	 * in-flight write serialised its snapshot earlier). Calls made while that
	 * final write runs join it, never start a parallel one.
	 */
	flush(): Promise<CheckpointWrite>;
	start(): Promise<string[]>;
	stop(): void;
}

/** The checkpoint file as found at boot: restored, absent, or refused with the reason to log once. */
interface CheckpointRead {
	checkpoint: SloCheckpoint | null;
	warning: string | null;
}

/**
 * Read the checkpoint synchronously at construction, because the registry's
 * start time and every instrument's prior layer must exist before the first
 * observation. An absent file is a fresh start with nothing to say; anything
 * else that fails — unreadable, over the size limit, not a checkpoint — is one
 * warning, and the process starts fresh rather than refusing to boot over its
 * own history. The path is quoted: it is a path, never a credential.
 */
function readCheckpointFile(path: string | null): CheckpointRead {
	if (path === null) return { checkpoint: null, warning: null };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { checkpoint: null, warning: null };
		return { checkpoint: null, warning: `slo checkpoint ${path} could not be read (${(cause as Error).message}); SLO history starts fresh` };
	}
	try {
		return { checkpoint: restoreCheckpoint(text), warning: null };
	} catch (cause) {
		const reason = cause instanceof CheckpointError ? cause.message : String(cause);
		return { checkpoint: null, warning: `slo checkpoint ${path} is not usable (${reason}); SLO history starts fresh` };
	}
}

/** The two filesystem calls a checkpoint write makes, injectable so a test can hold one open. */
export interface CheckpointFiles {
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export function createObservability(
	config: SubstrateConfig,
	env: Record<string, string | undefined> = process.env,
	files: CheckpointFiles = { writeFile, rename },
): Observability {
	const settings = loadObservabilityConfig(env, SUBSTRATE_VERSION);
	// uplift-3 N2: the prior epoch's checkpoint, before any instrument exists. A
	// restored registry starts at the history's `since`, so the OTLP start time and
	// `/metrics.startedAt` say what the cumulative points actually cover.
	const read = readCheckpointFile(config.sloCheckpointPath);
	const restored = read.checkpoint;
	const bootWarnings: string[] = read.warning === null ? [] : [read.warning];
	const instruments = new SubstrateInstruments(new MetricRegistry(restored ? Date.parse(restored.since) : Date.now()));
	// uplift-4 S6: registered before the seed below so a checkpoint restores the drop counter; with the history off it does not exist.
	if (config.metricsHistory.enabled) registerMetricsHistoryMetrics(instruments.registry);
	if (restored) {
		const skipped = instruments.registry.seed(restored.metrics);
		if (skipped.length > 0) {
			bootWarnings.push(`slo checkpoint carried ${skipped.length} metric(s) this release does not record or whose buckets moved, left out: ${skipped.join(", ")}`);
		}
	}
	// phase 51: the data planes on a configured proxy, counted from the endpoint classes at boot. The fabric's tailscale-proxy row reads the same classes.
	instruments.setEndpointProxyPlanes(Object.values(config.dbEndpoints.classes).filter((endpointClass) => endpointClass === "proxy").length);
	const epoch = restored ? restored.epoch + 1 : 1;
	const since = restored ? restored.since : new Date(instruments.registry.startedAt).toISOString();
	/** ISO time of the newest checkpoint write this process knows of. */
	let checkpointAt: string | null = restored?.writtenAt ?? null;
	const notifyRecords: Record<string, NotifyRecord> = { ...(restored?.notify ?? {}) };
	const tracer = new Tracer({ maxSpans: settings.maxSpans, sampleRatio: settings.sampleRatio });
	const audit = new AuditLog({ path: config.audit.path, redact });
	const slos = sloCatalogue(settings.slo);
	/** One window per process: successive `/slo` reads are its samples; restored buckets seed it. */
	const planeWindow = new PlaneWindow(undefined, undefined, restored?.planes ?? {});
	/** One ledger per process, the same way; restored samples seed it. */
	const burnLedger = new BurnLedger(undefined, undefined, restored?.burn ?? {});
	/** The `/healthz` size reads the runway is fitted over. */
	const capacityRing = new CapacityRing(restored?.capacity ?? []);
	/** How much of `tracer.dropped` has already been added to the monotonic counter. */
	let reportedSpanDrops = 0;
	let checkpointTimer: ReturnType<typeof setInterval> | null = null;
	/** One write at a time: a slow disk must not pile up `.part` renames. */
	let checkpointInFlight: Promise<CheckpointWrite> | null = null;
	/** Each write failure is logged once per reason, so a full disk is one line a boot, not one a minute. */
	const loggedWriteFailures = new Set<string>();

	const exporter = settings.exportEnabled
		? new PeriodicExporter({
				exporter: new OtlpExporter(settings.otlp, { redact }),
				snapshot: () => instruments.snapshot(),
				drainSpans: () => tracer.drain(),
				startedAt: instruments.registry.startedAt,
				intervalMs: settings.intervalMs,
				onResult: (result) => {
					// The tracer's own drops are a metric, not a silence: a buffer that is
					// overflowing is a fact about the deployment.
					//
					// The *delta*, not the total. `tracer.dropped` is itself cumulative, and
					// adding it whole to a monotonic counter every interval multiplies it —
					// five real drops would read as ten after two exports and fifteen after
					// three, turning a diagnostic into a fiction.
					const dropped = tracer.dropped;
					instruments.recordDroppedSpans(dropped - reportedSpanDrops);
					reportedSpanDrops = dropped;
					for (const outcome of [result.metrics, result.traces]) {
						if (!outcome.ok && outcome.items > 0) {
							process.stderr.write(`[substrate] otlp export failed (${outcome.items} items): ${outcome.error ?? outcome.status}\n`);
						}
					}
				},
			})
		: null;

	const observer: SubstrateObserver = {
		briefed(sample) {
			instruments.recordBrief(sample);
		},
		briefResult(sample) {
			instruments.recordBriefResult(sample);
		},
		briefProfiled(sample) {
			instruments.recordBriefProfile(sample);
		},
		servedTokens(sample) {
			instruments.recordServedTokens(sample);
		},
		briefRecall(sample) {
			instruments.recordBriefRecall(sample);
		},
		recallPrefetch(sample) {
			instruments.recordRecallPrefetch(sample);
		},
		hindsightOutbox(sample) {
			instruments.setHindsightOutbox(sample);
		},
		emitted(sample) {
			instruments.recordEmit(sample);
		},
		eventReplay(sample) {
			instruments.recordEventReplay(sample);
		},
		cached(sample) {
			instruments.recordCache(sample);
		},
		plane(sample) {
			instruments.recordPlane(sample);
		},
		admission(sample) {
			instruments.recordAdmission(sample);
		},
		memoryExpired(sample) {
			instruments.recordMemoryExpired(sample);
		},
		claimed(sample) {
			instruments.recordClaim({
				surface: sample.surface,
				graph_id: sample.graph_id,
				outcome: claimOutcome(sample.decision, sample.action),
			});
			if (sample.quarantineReason) {
				instruments.recordQuarantine({
					surface: sample.surface,
					graph_id: sample.graph_id,
					reason: sample.quarantineReason,
				});
			}
			// A withdrawal is a decision the audit has to carry, and the pre-dispatch gate
			// cannot know about it yet: see `recordClaimWithdrawal`.
			if (sample.decision === "revoked") {
				void recordClaimWithdrawal(audit, instruments, sample);
			}
		},
		docsSearch(sample) {
			instruments.recordDocsSearch(sample);
		},
		capacity(sample) {
			capacityRing.record(sample.at, sample.databaseBytes);
		},
		indexArchive(source) {
			instruments.observeIndexArchiveAge(() => source.newestAtMs());
		},
	};

	/**
	 * One atomic write: serialise, refuse a file over the read limit (a
	 * checkpoint the next boot would refuse is not worth the disk), write
	 * `<path>.part`, rename over `<path>`. Failures are returned and logged
	 * once per reason; nothing here throws into the timer or the shutdown path.
	 */
	async function writeCheckpoint(): Promise<CheckpointWrite> {
		const path = config.sloCheckpointPath;
		if (path === null) return { written: false, bytes: 0, error: null };
		const text = serializeCheckpoint(
			snapshotCheckpoint(instruments, planeWindow, burnLedger, epoch, { since, capacity: capacityRing.samples(), notify: notifyRecords }),
		);
		const bytes = Buffer.byteLength(text, "utf8");
		let error: string | null = null;
		if (bytes > MAX_CHECKPOINT_BYTES) {
			error = `checkpoint is ${bytes} bytes, over the ${MAX_CHECKPOINT_BYTES} byte limit the next boot would refuse`;
		} else {
			try {
				await files.writeFile(`${path}.part`, text, "utf8");
				await files.rename(`${path}.part`, path);
				checkpointAt = new Date().toISOString();
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
		}
		if (error !== null && !loggedWriteFailures.has(error)) {
			loggedWriteFailures.add(error);
			process.stderr.write(`[substrate] slo checkpoint ${path} not written: ${error}\n`);
		}
		return { written: error === null, bytes, error };
	}

	/**
	 * The single-flight door every trigger goes through — the periodic timer,
	 * `Observability.checkpoint()` and the shutdown write alike. A trigger that
	 * arrives while a write is in flight joins it rather than starting a second
	 * `.part` + rename over the same path; the timer calling `writeCheckpoint`
	 * directly bypassed this and could overlap a slow write with the next tick
	 * or with shutdown (Greptile round 1, PR #61).
	 */
	function checkpointOnce(): Promise<CheckpointWrite> {
		checkpointInFlight ??= writeCheckpoint().finally(() => {
			checkpointInFlight = null;
		});
		return checkpointInFlight;
	}

	/** The final write `flush()` is running, so a second shutdown call joins it. */
	let flushing: Promise<CheckpointWrite> | null = null;
	function flushCheckpoint(): Promise<CheckpointWrite> {
		flushing ??= (async () => {
			// The in-flight write's outcome is its own caller's business; this one
			// only needs it out of the way before the fresh snapshot is taken.
			if (checkpointInFlight !== null) await checkpointInFlight.catch(() => undefined);
			return checkpointOnce();
		})().finally(() => {
			flushing = null;
		});
		return flushing;
	}

	return {
		instruments,
		tracer,
		audit,
		slos,
		startedAt: instruments.registry.startedAt,
		resource: {
			name: settings.otlp.resource.serviceName,
			version: settings.otlp.resource.serviceVersion,
			instance: settings.otlp.resource.serviceInstanceId,
		},
		exporter,
		observer,
		snapshot: () => instruments.snapshot(),
		evaluate: () => evaluateSlos(instruments.snapshot(), slos),
		evaluatePlanes: (configured) =>
			evaluatePlaneSlos(instruments.snapshot(), {
				configured,
				window: planeWindow,
				...(settings.slo.planeAvailability !== undefined ? { target: settings.slo.planeAvailability } : {}),
				...(settings.slo.minSamples !== undefined ? { minSamples: settings.slo.minSamples } : {}),
			}),
		evaluateDocs: () => evaluateDocsSlos(instruments.snapshot(), settings.slo),
		evaluateBriefSurfaces: () => briefBySurfaceObjectives(instruments.snapshot(), settings.slo),
		evaluateBurn: () => evaluateBurnSlos(instruments.snapshot(), { ledger: burnLedger, env }),
		evaluateCapacity: () =>
			evaluateCapacitySlos(capacityRing, {
				volumeBytes: settings.indexVolumeBytes,
				...(settings.slo.runwayDays !== undefined ? { targetDays: settings.slo.runwayDays } : {}),
			}),
		evaluateServedTokens: () => servedTokensBySurface(instruments.snapshot(), { ledger: burnLedger, env }),
		notifyRecords,
		history: () => ({ epoch, since, checkpointAt }),
		checkpoint: checkpointOnce,
		flush: flushCheckpoint,
		async start() {
			const warnings: string[] = [];
			const opened = await audit.open();
			if (!opened.durable) {
				warnings.push(
					opened.error
						? `mcp audit chain is not durable — ${opened.error}; fail-closed tools will be refused`
						: "mcp audit chain is in memory only (SUBSTRATE_AUDIT_PATH is unset) and ends at the next restart",
				);
			}
			if (opened.missingHistory) {
				// Loud, at boot, and not only in a verdict somebody has to ask for. The operator
				// is the one who can say whether this was a rotation, a disk, or someone — and
				// the two cases point at different answers, so they must not read alike. A
				// rewritten file has the *same* count as was committed, so reporting it as
				// missing history printed two equal numbers and sent the reader after a deletion
				// that did not happen.
				const { kind, checkpointSeq, foundSeq } = opened.missingHistory;
				warnings.push(
					kind === "missing"
						? `mcp audit chain is missing history — ${checkpointSeq} record(s) were committed and the file accounts ` +
							`for ${foundSeq}; the chain continues from the checkpoint and every verification will report the gap`
						: `mcp audit chain has been rewritten — the record at seq ${checkpointSeq} is not the one whose hash was ` +
							"checkpointed, so the file holds a different chain than this deployment committed; the decisions it " +
							"shows are not the decisions that were made, and every verification will report it",
				);
			}
			if (!settings.exportEnabled) {
				warnings.push("no OTLP endpoint configured; metrics are collected and served but not exported");
			}
			// uplift-3 N2: said once, at boot, so a refused checkpoint is in the journal
			// beside the other degradations and not only in a missing `/slo.history`.
			warnings.push(...bootWarnings);
			if (config.sloCheckpointPath === null) {
				warnings.push("no SLO checkpoint path (SUBSTRATE_SLO_CHECKPOINT unset and no state directory); SLO history ends at the next restart");
			} else if (config.sloCheckpointS > 0 && checkpointTimer === null) {
				checkpointTimer = setInterval(() => void checkpointOnce(), config.sloCheckpointS * 1000);
				checkpointTimer.unref();
			}
			exporter?.start();
			return warnings;
		},
		stop() {
			exporter?.stop();
			if (checkpointTimer !== null) {
				clearInterval(checkpointTimer);
				checkpointTimer = null;
			}
		},
	};
}

// ── MCP audit gate ───────────────────────────────────────────────────────────

export interface McpToolCall {
	id: unknown;
	tool: string;
	args: unknown;
}

/**
 * The `tools/call` requests in a JSON-RPC body, batch or single.
 *
 * Anything else — `initialize`, `tools/list`, a notification — is not an action and
 * is not audited: a trail that recorded every handshake would bury the decisions it
 * exists to show.
 */
export function toolCallsIn(body: unknown): McpToolCall[] {
	const elements = Array.isArray(body) ? body : [body];
	const calls: McpToolCall[] = [];
	for (const element of elements) {
		if (!element || typeof element !== "object") continue;
		const message = element as { method?: unknown; id?: unknown; params?: unknown };
		if (message.method !== "tools/call") continue;
		const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
		if (typeof params.name !== "string") continue;
		calls.push({ id: message.id ?? null, tool: params.name, args: params.arguments });
	}
	return calls;
}

function stringAt(args: unknown, key: string): string | null {
	if (!args || typeof args !== "object" || Array.isArray(args)) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export interface AuditOutcome {
	/** id → message, for the calls that must not be dispatched. */
	denials: Map<string, string>;
}

/**
 * Every tool this substrate actually serves.
 *
 * The `tool` metric attribute is drawn from this list, not from the request. A
 * JSON-RPC `params.name` is an arbitrary caller-supplied string, so using it
 * directly let an authenticated caller mint one metric series per name it invented —
 * past the series cap, which collapses ids but kept `tool`. The audit chain still
 * records the name exactly as sent: that is a log, where the real value is the point,
 * and it is bounded by the file rather than by a process's live series map.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
	// MCP tools, as `mcp.ts` registers them.
	"memory_brief",
	"memory_write",
	"memory_search",
	"memory_recall",
	"memory_pending",
	"memory_verify",
	"checkpoint_verify",
	"session_checkpoint",
	"session_rollback_plan",
	"session_rollback_commit",
	"events_emit",
	"events_query",
	"events_verify",
	"graph_get",
	"graph_register",
	"graph_bind",
	"graph_claim",
	"graph_heartbeat",
	"graph_release",
	"graph_complete",
	"graph_find",
	"issue_get",
	"coord_handoff",
	"coord_handoff_verify",
	"coord_handoff_list",
	"coord_drift_scan",
	"coord_reap_leases",
	"skills_propose",
	"skills_approve",
	"skills_list",
	"docs_search",
	"docs_ingest",
	"docs_feedback",
	"desktop_run",
	"railway_list",
	"railway_monitor",
	"railway_scale_suggest",
	"railway_cost",
	"railway_scale",
	"railway_deploy",
	"fabric_status",
	"fabric_optimize",
	"fabric_compliance",
	"planning_status",
	"planning_sessions",
	"steering_queue",
	"steering_acknowledge",
	"steering_list",
	"corpus_status",
	"corpus_ingest",
	// REST routes, as `server.ts` audits them. A route audited under a tool's own name
	// (`/memory` as `memory_write`) is covered by that name above and not repeated.
	"brief",
	"events",
	"verify",
	"drift",
	"evidence",
]);

/** The bounded form of a tool name, for a metric attribute. */
export function toolLabel(tool: string): string {
	return KNOWN_TOOLS.has(tool) ? tool : "unrecognized";
}

/**
 * Record each tool call, and report the ones that must not run.
 *
 * A fail-closed tool whose record the chain refuses is denied. The denial is then
 * itself appended as a fail-open record — it will usually be refused too, since the
 * sink is what failed, which is why it is also written to stderr. Recording the
 * attempt matters more than recording it durably: an operator reading the journal
 * still learns that a claim was turned away and why.
 *
 * **Fail-closed calls are recorded first**, whatever order they arrived in. A batch
 * is refused whole, so a denial on the third call means the first two never ran —
 * and recording them as `allowed` before knowing that would put a claim in the trail
 * that the substrate never carried out. Only a fail-closed append can produce a
 * denial, so doing those first means a refused batch leaves no false `allowed`
 * record for any fail-open member. Within the fail-closed group a denial can still
 * follow an earlier success, which is what `batchNotDispatched` is for: the trail
 * gets an explicit record saying those calls were recorded but not dispatched,
 * because an append-only chain is corrected by appending, never by editing.
 */
export async function auditToolCalls(
	observability: Pick<Observability, "audit" | "instruments">,
	surface: Surface | null,
	calls: McpToolCall[],
	transport: AuditTransport = "mcp",
): Promise<AuditOutcome> {
	const denials = new Map<string, string>();
	const ordered = [...calls].sort(
		(a, b) => Number(auditMode(a.tool) === "fail-open") - Number(auditMode(b.tool) === "fail-open"),
	);
	/** The calls this batch has already recorded `allowed`, for a correction to name. */
	const recorded: RecordedCall[] = [];

	for (const call of ordered) {
		const label = toolLabel(call.tool);
		const context = {
			surface: surface ?? "unknown",
			tool: call.tool,
			transport,
			graph_id: stringAt(call.args, "graph_id"),
			node_id: stringAt(call.args, "node_id"),
			session_id: stringAt(call.args, "session_id"),
		};
		// Once the batch is refused, nothing else will be dispatched, so nothing else is
		// recorded as allowed either.
		if (denials.size > 0) {
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "denied" });
			continue;
		}
		try {
			const appended = await observability.audit.append({
				...context,
				decision: "allowed",
				mode: auditMode(call.tool),
				args: call.args,
			});
			observability.instruments.recordAudit({ decision: "allowed", written: appended.written });
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "allowed" });
			recorded.push({ surface: context.surface, graph_id: context.graph_id });
		} catch (cause) {
			if (!(cause instanceof AuditUnavailableError)) throw cause;
			const message = redact(cause.message);
			denials.set(String(call.id), message);
			process.stderr.write(`[substrate] denied ${call.tool} for ${context.surface} — ${message}\n`);
			const written = await observability.audit
				.append({ ...context, decision: "denied", mode: "fail-open", reason: message, args: call.args })
				.then((appended) => appended.written)
				.catch(() => false);
			observability.instruments.recordAudit({ decision: "denied", written });
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "denied" });
			await batchNotDispatched(observability, transport, recorded);
		}
	}
	return { denials };
}

/** A call already recorded `allowed` in this batch, for the correction to name. */
interface RecordedCall {
	surface: string;
	graph_id: string | null;
}

/**
 * Append a correction when a refused batch had already recorded some calls allowed.
 *
 * The chain is append-only, so the earlier `allowed` records cannot be withdrawn.
 * They are true about what was *asked and permitted*; what changed is that the batch
 * was then refused whole and none of it ran. Saying so in its own record is the only
 * honest way to express that, and it keeps an incident reader from concluding a claim
 * was carried out.
 *
 * **One correction per graph the batch touched**, not one per batch. A record carries a
 * single `graph_id`, and `buildGraphEvidence` selects by exactly that field — so a
 * correction with no graph was filtered out of every bundle while the earlier
 * `allowed` record, which *does* name its graph, was kept. That graph's evidence then
 * showed a claim as allowed with nothing saying it never ran, which is precisely the
 * reading this correction exists to prevent. Each affected graph gets its own, counting
 * only its own calls; a call that named no graph is corrected under a null one, the same
 * place its `allowed` record sits.
 */
async function batchNotDispatched(
	observability: Pick<Observability, "audit" | "instruments">,
	transport: AuditTransport,
	recorded: RecordedCall[],
): Promise<void> {
	if (recorded.length === 0) return;

	const byGraph = new Map<string | null, { surface: string; count: number }>();
	for (const call of recorded) {
		const group = byGraph.get(call.graph_id);
		if (group) group.count++;
		else byGraph.set(call.graph_id, { surface: call.surface, count: 1 });
	}

	for (const [graph_id, { surface, count }] of byGraph) {
		const written = await observability.audit
			.append({
				surface,
				tool: "batch",
				transport,
				graph_id,
				decision: "denied",
				mode: "fail-open",
				reason:
					`the batch was refused whole after ${count} call(s)${graph_id ? " for this graph" : ""} had already ` +
					"been recorded as allowed; none of them was dispatched",
			})
			.then((appended) => appended.written)
			.catch(() => false);
		observability.instruments.recordAudit({ decision: "denied", written });
	}
}

const BATCH_REFUSED =
	"not dispatched: another call in this batch could not be recorded in the MCP audit chain, and the batch is " +
	"refused whole rather than partly applied";

/**
 * The JSON-RPC error body for a refused request.
 *
 * A batch is refused whole. Dispatching the allowed half would leave the caller
 * holding a partial result it has no way to tell from a complete one, and MCP
 * clients send one call per request in practice, so nothing real pays for the
 * strictness.
 */
export function auditRefusal(body: unknown, denials: Map<string, string>): unknown {
	const elements = Array.isArray(body) ? body : [body];
	const responses = elements.map((element) => {
		const id = element && typeof element === "object" ? ((element as { id?: unknown }).id ?? null) : null;
		return {
			jsonrpc: "2.0" as const,
			id,
			error: { code: -32000, message: denials.get(String(id)) ?? BATCH_REFUSED },
		};
	});
	return Array.isArray(body) ? responses : responses[0];
}

// ── request instrumentation ──────────────────────────────────────────────────

export function traceparentOf(req: IncomingMessage): SpanContext | null {
	const header = req.headers.traceparent;
	return parseTraceparent(Array.isArray(header) ? header[0] : header);
}

/** A server span for one request, with the substrate's own attributes on it. */
export function startRequestSpan(
	observability: Pick<Observability, "tracer">,
	req: IncomingMessage,
	route: string,
	surface: Surface | null,
): Span {
	return observability.tracer.startSpan(`${req.method ?? "GET"} ${route}`, {
		kind: SPAN_KIND.server,
		parent: traceparentOf(req),
		attributes: {
			"http.request.method": req.method ?? "GET",
			"http.route": route,
			"substrate.surface": surface,
		},
	});
}

// ── evidence ─────────────────────────────────────────────────────────────────

/** How many of one graph's audit records a bundle carries. Beyond this, a note says so. */
export const MAX_EVIDENCE_RECORDS = 5000;

/**
 * Assemble the bundle for one graph.
 *
 * Only audit records naming the graph are included — a record with no `graph_id`
 * belongs to no graph, and folding those in would make every bundle a copy of the
 * whole trail.
 *
 * **One pass over the audit file, not two.** Verifying it and then selecting the
 * graph's records used to be two whole reads and two whole parses, with the request's
 * own record appended between them — so an ordinary authenticated `/evidence` call cost
 * twice a trail that has no compaction, and a few of them in a row could take the MCP
 * process down with the substrate on the critical path of every prompt on the host.
 * `verifiedView` does both in one streaming pass, holds this graph's records rather
 * than all of them, and stops collecting at `MAX_EVIDENCE_RECORDS` — so the cost is
 * proportional to the graph being asked about, whatever the file grew to around it.
 */
export async function buildGraphEvidence(
	observability: Observability,
	substrate: Substrate,
	graphId: string,
	notes: string[] = [],
	/** How many of the graph's records to list. Lowered by tests that exercise the bound. */
	maxRecords: number = MAX_EVIDENCE_RECORDS,
	/** The devnet reader and clock the hour check uses (D41-6). Tests inject a fake RPC; production leaves both unset. */
	verify: Pick<VerifyOptions, "rpc" | "now"> = {},
): Promise<EvidenceBundle> {
	// One verify, with the hour report (D41-1): the chain verdict and the anchors come from one read.
	// A verify that throws leaves the chain unverifiable and the anchors unread, rather than failing the bundle.
	let verdict: VerifyVerdict | null = null;
	let verifyFailure = "";
	try {
		// The hour loop is bounded by SUBSTRATE_VERIFY_TIMEOUT_MS (`verifyTimeoutMs`). An hour past that
		// budget reads `unverified` with its reason, so the bundle still arrives; the CLI waits that budget
		// plus a margin for this request (`cmdEvidence`).
		verdict = await substrate.verifyGraph(graphId, { ...verify, anchors: true });
	} catch (cause) {
		verifyFailure = redact(String(cause));
	}
	const appChain: ChainEvidence = verdict
		? appChainOf(verdict)
		: { state: "unverifiable", ok: null, records: 0, reason: verifyFailure };
	const anchors: AnchorEvidence[] = verdict ? verdict.hours.map(anchorEvidenceOf) : [];
	const teachableNotes: string[] = [];
	let teachables: TeachableEvidence[] = [];
	try {
		teachables = teachableEvidenceOf(await substrate.graphTeachables(graphId), anchors);
	} catch (cause) {
		teachableNotes.push(`The teachable moments of this graph could not be read: ${redact(String(cause))}`);
	}

	const {
		verdict: chain,
		records: forGraph,
		total,
		stats,
		matched,
		selector,
	} = await observability.audit.verifiedView(graphId, maxRecords);

	const lost = observability.audit.missingHistory;

	return buildEvidence({
		// The cleaned form, not the string the caller asked with: it is the key both the audit
		// records and the metric attributes are stored under, and this document must not echo
		// a credential that every other field redacted. They are the same string for every
		// ordinary identifier. See `EvidenceInput.graph_id`.
		graph_id: selector,
		service: observability.resource,
		slos: observability.evaluate(),
		appChain,
		anchors,
		teachables,
		audit: {
			chain,
			durable: observability.audit.durable,
			path: observability.audit.path,
			records: forGraph,
			// The tally covers every record naming this graph; `records` is the listed window
			// of them. Deriving the counts from the window would understate a busy graph.
			stats,
			// A cleaned identifier is not a unique key: another graph cleaning to the same
			// string is indistinguishable once stored, so this selection cannot be claimed as
			// one graph's. `substrate evidence` exits non-zero on it.
			attribution: selector === graphId ? "exact" : "ambiguous",
		},
		metrics: observability.snapshot(),
		// Every note names the graph by `selector`, never by the raw `graphId`. A note is
		// bundle content — it lands in the JSON, in the HTML rendered from it, and in whatever
		// archive those end up in — so interpolating the requested identifier there put the
		// credential back into the document that `graph_id` had just been cleaned to keep out.
		notes: [
			...(matched === 0 && total > 0
				? [`No MCP audit record names ${selector}; ${total} record(s) in the chain belong to other graphs or to none.`]
				: []),
			...(matched > forGraph.length
				? [
						`${matched} audit records name ${selector} and the ${forGraph.length} most recent are listed; the tally above ` +
							`counts all ${matched}, and the chain verdict covers all ${total} record(s) in the file.`,
					]
				: []),
			...(selector !== graphId
				? [
						"The identifier this bundle was requested with is not the one named above: redaction or the length cap " +
							"changed it, so the graph is named, keyed and reported here in its stored form. Another graph whose " +
							"identifier cleans to the same string would share this selection, and nothing in the audit file can " +
							"separate them — which is why the attribution is `ambiguous`.",
					]
				: []),
			...(lost
				? [
						lost.kind === "missing"
							? "The MCP audit file is missing history: this process committed more records than the file now accounts " +
								"for, so decisions taken before the loss are not in this bundle and cannot be recovered from it."
							: "The MCP audit file has been replaced: the record at the last checkpointed position is not the one whose " +
								"hash was committed, so the decisions this bundle lists are not the decisions that were made.",
					]
				: []),
			...(verdict === null
				? ["The hour anchors of this graph were not read: its chain verification did not complete, so no hour is listed."]
				: []),
			...teachableNotes,
			...notes,
		],
	});
}

/** The app-events chain, from the chain verdict alone: the hour report is not part of it. */
function appChainOf(verdict: VerifyVerdict): ChainEvidence {
	// `greptime not configured` is a deployment with no ledger, not a ledger that would not answer.
	const notConfigured = verdict.chain.reason === "greptime not configured";
	return {
		state: notConfigured ? "not-configured" : chainState(verdict.chain.ok),
		ok: notConfigured ? null : verdict.chain.ok,
		records: verdict.events,
		...(verdict.chain.brokenAt ? { brokenAt: verdict.chain.brokenAt } : {}),
		...(verdict.chain.reason ? { reason: verdict.chain.reason } : {}),
	};
}

/**
 * One hour of the verify report, as a bundle anchor (D41-1, D41-5). Only `anchored` and `pending`
 * pass. Every other status fails verify (`unanchored`, `mismatch`, `unverified`), so it reads as
 * `unverified` here, with its reason.
 */
function anchorEvidenceOf(hour: HourReport): AnchorEvidence {
	const status: AnchorState = hour.status === "anchored" || hour.status === "pending" ? hour.status : "unverified";
	return {
		period_start: hour.period_start,
		period_end: hour.period_end,
		status,
		event_count: hour.event_count,
		root: hour.root,
		...(hour.tx_sig ? { tx_sig: hour.tx_sig, explorer_url: devnetExplorerTxUrl(hour.tx_sig) } : {}),
		...(hour.slot === undefined ? {} : { slot: hour.slot }),
		...(hour.reason ? { reason: hour.reason } : {}),
	};
}

/**
 * A graph's teachables, each with the anchor of its hour (D41-4). A teachable is anchored when its
 * hour is, and its content still hashes to what the ledger stored: the hour's root holds the stored
 * hash, so a teachable altered after its hour was anchored is not anchored, whatever the hour says.
 * An event with no hour has no anchor.
 */
function teachableEvidenceOf(teachables: GraphTeachable[], anchors: AnchorEvidence[]): TeachableEvidence[] {
	const byHour = new Map(anchors.map((anchor) => [anchor.period_start, anchor]));
	return teachables.map((teachable) => {
		const anchor = teachable.hour === null ? undefined : byHour.get(teachable.hour);
		return {
			event_id: teachable.event_id,
			graph_id: teachable.graph_id,
			...(teachable.session_id ? { session_id: teachable.session_id } : {}),
			content_sha256: teachable.content_sha256,
			hour: teachable.hour,
			anchored: !teachable.tampered && anchor?.status === "anchored",
			...(teachable.tampered ? { reason: "tampered" } : {}),
			...(anchor?.tx_sig && anchor.explorer_url ? { tx_sig: anchor.tx_sig, explorer_url: anchor.explorer_url } : {}),
		};
	});
}

/** A verdict's three-way state, for the `ok` a bundle carries alongside it. */
export function chainState(ok: boolean | null): "verified" | "broken" | "unverifiable" {
	if (ok === true) return "verified";
	if (ok === false) return "broken";
	return "unverifiable";
}

export { auditStats, renderEvidenceHtml };
