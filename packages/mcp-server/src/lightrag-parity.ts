export interface ParityDocument {
	dataset: string;
	sourceUrl: string;
	version: string;
}

export interface ParityQuery {
	id: string;
	expectedSources: readonly string[];
}

export interface ParityAnswer {
	queryId: string;
	citedSources: readonly string[];
}

export interface ParityInput {
	source: readonly ParityDocument[];
	migrated: readonly ParityDocument[];
	queries: readonly ParityQuery[];
	answers: readonly ParityAnswer[];
	requiredMatchRate?: number;
}

export interface ParityReport {
	passed: boolean;
	recordMismatches: string[];
	queryMisses: string[];
	matched: number;
	total: number;
	matchRate: number;
}

const DEFAULT_REQUIRED_MATCH_RATE = 1;

function documentKey(document: ParityDocument): string {
	return JSON.stringify([document.dataset, document.sourceUrl, document.version]);
}

function checkRecords(
	source: readonly ParityDocument[],
	migrated: readonly ParityDocument[],
): string[] {
	const unmatched = new Map<string, number>();
	for (const document of migrated) {
		const key = documentKey(document);
		unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
	}

	const mismatches: string[] = [];
	for (const document of source) {
		const key = documentKey(document);
		const left = unmatched.get(key) ?? 0;
		if (left > 0) {
			unmatched.set(key, left - 1);
		} else {
			mismatches.push(`missing ${document.dataset} ${document.sourceUrl} ${document.version}`);
		}
	}
	for (const document of migrated) {
		const key = documentKey(document);
		const left = unmatched.get(key) ?? 0;
		if (left > 0) {
			unmatched.set(key, left - 1);
			mismatches.push(`unexpected ${document.dataset} ${document.sourceUrl} ${document.version}`);
		}
	}
	return mismatches;
}

function sameSources(cited: readonly string[], expected: readonly string[]): boolean {
	const citedSet = new Set(cited);
	const expectedSet = new Set(expected);
	return citedSet.size === expectedSet.size && [...expectedSet].every((source) => citedSet.has(source));
}

export function checkParityGate(input: ParityInput): ParityReport {
	const requiredMatchRate = input.requiredMatchRate ?? DEFAULT_REQUIRED_MATCH_RATE;
	if (!Number.isFinite(requiredMatchRate) || requiredMatchRate <= 0 || requiredMatchRate > 1) {
		throw new TypeError(`requiredMatchRate must be a finite number in (0, 1], got ${requiredMatchRate}`);
	}

	const queryIds = new Set<string>();
	for (const query of input.queries) {
		if (query.expectedSources.length === 0) {
			throw new TypeError(`query ${query.id} has an empty expectedSources list`);
		}
		if (queryIds.has(query.id)) {
			throw new TypeError(`duplicate query id ${query.id}`);
		}
		queryIds.add(query.id);
	}

	const recordMismatches = checkRecords(input.source, input.migrated);

	const answerCounts = new Map<string, number>();
	const answerById = new Map<string, ParityAnswer>();
	for (const answer of input.answers) {
		answerCounts.set(answer.queryId, (answerCounts.get(answer.queryId) ?? 0) + 1);
		answerById.set(answer.queryId, answer);
	}

	const queryMisses: string[] = [];
	let matched = 0;
	for (const query of input.queries) {
		const answer = answerById.get(query.id);
		if (answer === undefined) {
			queryMisses.push(`${query.id}: no answer`);
		} else if ((answerCounts.get(query.id) ?? 0) > 1) {
			queryMisses.push(`${query.id}: multiple answers`);
		} else if (sameSources(answer.citedSources, query.expectedSources)) {
			matched += 1;
		} else {
			queryMisses.push(
				`${query.id}: cites [${[...answer.citedSources].sort().join(", ")}] expected [${[...query.expectedSources].sort().join(", ")}]`,
			);
		}
	}

	const total = input.queries.length;
	const matchRate = total === 0 ? 0 : matched / total;
	const passed = total > 0 && recordMismatches.length === 0 && matchRate >= requiredMatchRate;

	return { passed, recordMismatches, queryMisses, matched, total, matchRate };
}
