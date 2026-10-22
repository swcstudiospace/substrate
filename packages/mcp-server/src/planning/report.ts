/**
 * A session's planning report (phase 53, SOTA-09): the phases its checkout's index holds and the plan ids under each,
 * or the reason its view is unknown. Pure: a scan in, a report out. The observer writes the report into the session's
 * presence record, which is how every other session sees it.
 *
 * - A plan's identity is the plan id its parsed content declares, so one plan under two filenames is one plan. A document
 *   that declares none keeps its filename-derived id.
 * - A watcher gap is an incomplete observation: a truncated index, or one with unlisted directories. The phase 52 observer
 *   reports such a scan as partial and publishes nothing from it. Here the gap marks the report unknown. Only a complete
 *   scan clears it. A failed scan proves nothing either way, so it keeps the gap it had.
 * - An index with unreadable records is unknown, and so is a report that would exceed `MAX_REPORT_ENTRIES` or hold an
 *   identifier outside the presence schema (`report-limit`). A report is never cut short, because a cut report would
 *   claim absences it cannot prove.
 */
import { indexRecords, isErrorRecord, type PlanningFileRecord, type PlanningIndexResult, type PlanningRecord } from "./index.ts";
import { MAX_REPORT_ENTRIES, type PhaseReport, type PlanningReport, type UnknownViewReason } from "./presence.ts";

const REPORT_ID_MAX = 128;

/** The reasons an incomplete observation opens a gap. */
export type WatcherGap = "scan-truncated" | "scan-unlisted";

export interface ObservedScan {
	report: PlanningReport;
	/** The gap after this scan: a new one, the one held, or null once a complete scan has cleared it. */
	gap: WatcherGap | null;
}

/** The report and the gap after one scan. A gap, whether new or held, makes the report unknown. */
export function observeScan(result: PlanningIndexResult, scannedAtMs: number, gap: WatcherGap | null): ObservedScan {
	if (!result.ok) return { report: unknownReport(scannedAtMs, "scan-failed"), gap };
	const { index } = result;
	const nextGap: WatcherGap | null = index.truncated ? "scan-truncated" : index.unlisted.length > 0 ? "scan-unlisted" : null;
	if (nextGap !== null) return { report: unknownReport(scannedAtMs, nextGap), gap: nextGap };
	return { report: completeReport(indexRecords(index), scannedAtMs), gap: null };
}

export function unknownReport(scannedAtMs: number, reason: UnknownViewReason): PlanningReport {
	return { status: "unknown", scannedAtMs, reason };
}

/** The report of a complete index, with no gap open. */
function completeReport(records: readonly PlanningRecord[], scannedAtMs: number): PlanningReport {
	if (records.some(isErrorRecord)) return unknownReport(scannedAtMs, "scan-has-errors");

	const plansByPhase = new Map<string, Set<string>>();
	for (const record of records) {
		if (isErrorRecord(record) || record.phase === undefined || record.phase === "") continue;
		const plans = plansByPhase.get(record.phase) ?? new Set<string>();
		const plan = planIdentity(record);
		if (plan !== undefined) plans.add(plan);
		plansByPhase.set(record.phase, plans);
	}

	let entries = plansByPhase.size;
	for (const [phase, plans] of plansByPhase) {
		if (phase.length > REPORT_ID_MAX) return unknownReport(scannedAtMs, "report-limit");
		for (const plan of plans) if (plan.length > REPORT_ID_MAX) return unknownReport(scannedAtMs, "report-limit");
		entries += plans.size;
	}
	if (entries > MAX_REPORT_ENTRIES) return unknownReport(scannedAtMs, "report-limit");

	const phases: PhaseReport[] = [...plansByPhase]
		.sort(([a], [b]) => compareText(a, b))
		.map(([phase, plans]) => ({ phase, plans: [...plans].sort(compareText) }));
	return { status: "known", scannedAtMs, phases };
}

/**
 * A plan's identity is the plan id its parsed content declares, so the same plan under two filenames is one plan. A document
 * whose content declares none keeps its filename-derived id. A document that is neither a plan nor declares one has none.
 */
export function planIdentity(record: PlanningFileRecord): string | undefined {
	const declared = record.frontmatter?.plan;
	if (typeof declared === "string" && declared.length > 0) return declared;
	if (typeof declared === "number") return String(declared);
	return record.plan === "" ? undefined : record.plan;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
