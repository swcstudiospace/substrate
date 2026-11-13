/**
 * The repository each dataset's records are keyed under: a record is `lightrag::<repository>::<source URL>`, and the normal
 * refresh reads the same key through `lightragSearchDatasets(names, datasetIdentity)`. It is a table, not the checkout's
 * origin: an origin changes when its repository is renamed, and a key that followed the rename would strand every record the
 * old name wrote.
 */
export const DATASET_REPOS: Readonly<Record<string, string>> = {
	"agent-substrate": "swcstudiospace/agent-substrate",
	substrate: "swcstudiospace/substrate",
	"programming-desk": "swcstudiospace/programming-desk",
	kanbanos: "swcstudiospace/kanbanos",
	desklanes: "swcstudiospace/desklanes",
	clippyos: "swcstudiospace/clippyos",
	auctioning: "swcstudiospace/auctioning",
	"agent-skills": "swcstudiospace/agent-skills",
};

/** The identity a dataset's records are keyed under: its mapped repository, or its name when none is mapped. */
export function datasetIdentity(dataset: string): string {
	const mapped = Object.hasOwn(DATASET_REPOS, dataset) ? DATASET_REPOS[dataset] : undefined;
	return mapped ?? dataset;
}
