/**
 * The gate-accepted retain forward into the writer's `sub-<surface>` bank.
 *
 * DOCS-04's write half (D26-04): after the index write returns `accepted`
 * with `verified_persisted`, the accepted record is forwarded — redacted,
 * carrying its source, idempotent by `document_id` — into the writer's bank,
 * which `ensureBank` first pins to `chunks` mode so the plane stores the
 * accepted text as-is. Postgres stays the governed store: the forward never
 * blocks the write's accepted reply, and any refusal or failure emits the
 * existing `memory.retain.failed` warning with locators plus hashes, never
 * values (D26-07, Phase 21 precedent). A refusal is never cleaned-and-
 * published: any redactor finding stops the forward outright.
 */
import {
	bankForSurface,
	ensureBank,
	retainMemories,
	type FetchLike,
	type HindsightConfig,
} from "./planes/hindsight.ts";
import { applyRule, redact, REDACTION_RULES } from "./redact.ts";
import { SURFACES, type EventInput, type MemoryWriteRequest, type MemoryWriteResult } from "./types.ts";

/** The known surfaces as plain strings, for the emit-surface check. */
const KNOWN_SURFACES: readonly string[] = SURFACES;

export interface RetainDeps {
	config: HindsightConfig | null;
	fetchImpl?: FetchLike;
	/** A guest instance never forwards bytes to the plane (D25-05 posture). */
	vmGuest?: boolean;
	emit: (event: EventInput) => Promise<unknown>;
}

export interface ForwardOutcome {
	forwarded: boolean;
	bank: string;
	document_id: string;
	reason?: string;
	rules?: string[];
}

/** Which redaction rules fire on the text, for the locator-only warning. */
function findingRules(text: string): string[] {
	const found: string[] = [];
	for (const rule of REDACTION_RULES) {
		if (applyRule(rule.name, text) !== text) found.push(rule.name);
	}
	if (found.length === 0 && redact(text) !== text) found.push("structural");
	return found;
}

async function warn(
	deps: RetainDeps,
	writer: string,
	sessionId: string | undefined,
	summary: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const line = redact(summary);
	if (!KNOWN_SURFACES.includes(writer)) {
		process.stderr.write(`[substrate] ${line} by ${redact(writer)}\n`);
		return;
	}
	await deps
		.emit({
			surface: writer as EventInput["surface"],
			kind: "warning",
			summary: line,
			...(sessionId !== undefined ? { session_id: sessionId } : {}),
			payload: { action: "memory.retain", ...payload },
		})
		.catch((cause: unknown) => {
			process.stderr.write(`[substrate] ${line} (emit failed: ${redact(String(cause))})\n`);
		});
}

/**
 * Forward one accepted write. Unaccepted, unverified, or unconfigured writes
 * forward nothing and warn nothing — the gate owns that trail. Everything
 * else that stops the forward is a `memory.retain.failed` warning.
 */
export async function forwardRetain(
	deps: RetainDeps,
	request: MemoryWriteRequest,
	result: MemoryWriteResult,
): Promise<ForwardOutcome> {
	const entry = result.entry;
	if (result.outcome !== "accepted" || !result.verified_persisted || !entry) {
		return { forwarded: false, bank: "", document_id: "", reason: "not-accepted" };
	}
	if (!deps.config) {
		return { forwarded: false, bank: "", document_id: "", reason: "hindsight is not configured" };
	}
	const config = deps.config;
	const bank = bankForSurface(config, result.writer);
	const documentId = result.idempotency_key;
	const sessionId = typeof request.session_id === "string" && request.session_id.length > 0 ? request.session_id : undefined;
	if (deps.vmGuest === true) {
		const reason = "vm-guest";
		await warn(deps, result.writer, sessionId, `hindsight retain refused: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	}
	const source = typeof request.source_event === "string" && request.source_event.length > 0 ? request.source_event : undefined;
	if (!source) {
		const reason = "retain.unsourced";
		await warn(deps, result.writer, sessionId, `hindsight retain refused: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	}
	const context = `memory ${entry.kind} at ${entry.scope}`;
	const metadata: Record<string, string> = {
		surface: result.writer,
		scope: entry.scope,
		kind: entry.kind,
		source,
		entry_id: entry.id,
		created: entry.created,
	};
	if (typeof entry.subject === "string" && entry.subject.length > 0) metadata.subject = entry.subject;
	const texts = [entry.text, context, ...Object.values(metadata)];
	const rules = [...new Set(texts.flatMap((text) => findingRules(text)))];
	if (rules.length > 0) {
		const reason = "retain.unredacted";
		await warn(deps, result.writer, sessionId, `hindsight retain refused: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			rule: rules.join(","),
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason, rules };
	}
	const fetchImpl = deps.fetchImpl ?? fetch;
	const ensured = await ensureBank(config, bank, fetchImpl);
	if (!ensured.ok) {
		const reason = `ensure-bank-${ensured.error.kind}`;
		await warn(deps, result.writer, sessionId, `hindsight retain failed: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	}
	const retained = await retainMemories(
		config,
		bank,
		[{ content: entry.text, context, tags: [result.writer, entry.kind], metadata, document_id: documentId }],
		fetchImpl,
	);
	if (!retained.ok) {
		const reason = `retain-${retained.error.kind}`;
		await warn(deps, result.writer, sessionId, `hindsight retain failed: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	}
	return { forwarded: true, bank, document_id: documentId };
}
