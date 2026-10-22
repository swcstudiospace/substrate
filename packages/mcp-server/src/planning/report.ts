/**
 * A session's planning report (phase 53, SOTA-09): the phases its checkout's index holds and the plan ids under each,
 * or the reason its view is unknown. Pure: a scan in, a report out. The reader writes the report into the session's
 * presence record, which is how every other session sees it.
 *
 * - A plan's identity is the plan id its parsed content declares, so one plan under two filenames is one plan. A document
 *   that declares none keeps its filename-derived id.
 * - A truncated index, a failed scan, or an index with unreadable records is unknown. Its phases are not trusted.
 * - A report that would exceed `MAX_REPORT_ENTRIES`, or holds an identifier outside the presence schema, is unknown as
 *   `report-limit`. It is never cut short, because a cut report would claim absences it cannot prove.
 */
import { isErrorRecord, type PlanningFileRecord, type PlanningIndexResult } from "./index.ts";
import { MAX_REPORT_ENTRIES, type PhaseReport, type PlanningReport, type UnknownViewReason } from "./presence.ts";

const REPORT_ID_MAX = 128;

export function reportFromScan(result: PlanningIndexResult, scannedAtMs: number): PlanningReport {
	if (!result.ok) return unknownReport(scannedAtMs, "scan-failed");
	const { records, truncated } = result.index;
	if (truncated) return unknownReport(scannedAtMs, "scan-truncated");
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

export function unknownReport(scannedAtMs: number, reason: UnknownViewReason): PlanningReport {
	return { status: "unknown", scannedAtMs, reason };
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
