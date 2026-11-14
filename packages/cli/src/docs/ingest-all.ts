/**
 * `substrate docs ingest-all` — the operator's all-markdown docs ingest (packages/mcp-server/src/docs-allmarkdown.ts).
 *
 *   substrate docs ingest-all --state-dir DIR [--roots DIR,DIR] [--group NAME] [--dry-run | --apply]
 *
 * Every `*.md` file under the roots' repo checkouts and worktrees is gated the way the guarded ingest gates it. The pages
 * that pass go through `Substrate.ingestDocs`, one LightRAG dataset per repo. The roots default to `~/src/repos` and
 * `~/src/worktrees`. Without `--apply` the job writes `report.json`, `summary.md` and `leave-out.json` into `--state-dir`
 * and sends nothing. Refused pages are listed in the leave-out file by path, rule names and content hash only.
 *
 * This runs in the CLI process with the operator's environment, and only when the `substrate` dispatcher calls it. The
 * server never does, so nothing here runs at boot or on a timer. The server package is imported dynamically on purpose:
 * a static import would load `service.ts` and its graph into every other `substrate` command's start-up.
 *
 * Exit codes: 0 when the run completed (or was a dry run), 1 when a batch was refused or a page failed, 2 on usage.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestCall } from "../../../mcp-server/src/docs-allmarkdown.ts";
import { parseArgs, str, type Args } from "../args.ts";

export const INGEST_ALL_USAGE = "substrate docs ingest-all --state-dir DIR [--roots DIR,DIR] [--group NAME] [--dry-run | --apply]\n";

const KNOWN_FLAGS = new Set(["state-dir", "roots", "group", "apply", "dry-run", "help"]);

export interface IngestAllDeps {
	out: (text: string) => void;
	err: (text: string) => void;
	/** True only when the `substrate` dispatcher calls this command. Anything else is refused before a file is read. */
	invokedFromCli: boolean;
}

export async function runDocsIngestAll(argv: string[], deps: IngestAllDeps): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(INGEST_ALL_USAGE);
		return 0;
	}
	if (!deps.invokedFromCli) {
		deps.err("[substrate] docs ingest-all runs only from the substrate CLI; nothing was read or written\n");
		return 2;
	}
	const usage = (message: string): number => {
		deps.err(`[substrate] docs ingest-all: ${message}\n${INGEST_ALL_USAGE}`);
		return 2;
	};
	const args: Args = parseArgs(argv);
	const unknown = Object.keys(args).find((key) => !KNOWN_FLAGS.has(key));
	if (unknown !== undefined) return usage(`unknown flag --${unknown}`);
	const valued = ["state-dir", "roots", "group"].find((key) => args[key] === true);
	if (valued !== undefined) return usage(`--${valued} takes a value`);
	if (typeof args.apply === "string") return usage("--apply takes no value");
	if (typeof args["dry-run"] === "string") return usage("--dry-run takes no value");
	const apply = args.apply === true;
	if (apply && args["dry-run"] === true) return usage("--apply and --dry-run exclude each other");
	const stateDir = str(args["state-dir"]);
	if (stateDir === undefined) return usage("--state-dir DIR is required");
	const home = homedir();
	const reposRoot = join(home, "src", "repos");
	const roots = str(args.roots)
		?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0) ?? [reposRoot, join(home, "src", "worktrees")];
	const only = str(args.group);
	const generatedAt = new Date().toISOString();
	try {
		const { loadConfig } = await import("../../../mcp-server/src/config.ts");
		const { knownDatasets, planningDatasetRegistry } = await import("../../../mcp-server/src/docs-datasets.ts");
		const { nodePlanningFs } = await import("../../../mcp-server/src/planning/fs.ts");
		const { planningSessionId } = await import("../../../mcp-server/src/planning/checkout.ts");
		const { discoverGroups, nodeMarkdownFs, planAllMarkdown, runAllMarkdownIngest } = await import("../../../mcp-server/src/docs-allmarkdown.ts");

		const config = loadConfig();
		const fs = nodeMarkdownFs();
		const planningFs = nodePlanningFs();
		// The datasets the service accepts: the planning registry of the configured checkouts, plus the skills and corpus datasets.
		const known = new Set(knownDatasets(await planningDatasetRegistry(config.planningCheckouts, planningFs)));

		const discovered = await discoverGroups(fs, { roots, reposRoot });
		if (only !== undefined && !discovered.groups.some((group) => group.key === only)) return usage(`no group named ${only}`);
		const groups = only === undefined ? discovered.groups : discovered.groups.filter((group) => group.key === only);
		const keyed = groups.map((group) => {
			const root = group.units[0]?.path ?? group.key;
			return { group, root, key: planningSessionId(planningFs, root) };
		});
		const registry = await planningDatasetRegistry(
			keyed.map(({ root, key }) => ({ root, key })),
			planningFs,
			reposRoot,
		);
		const datasets = new Map<string, string>();
		for (const { group, key } of keyed) {
			const dataset = registry.datasetOf.get(key);
			if (dataset !== undefined) datasets.set(group.key, dataset);
		}
		const plan = await planAllMarkdown({
			fs,
			discovered: { ...discovered, groups },
			datasets,
			known,
			roots,
			reposRoot,
			generatedAt,
		});
		const sessionId = `docs-allmarkdown:${generatedAt}`;
		if (!apply) {
			return runAllMarkdownIngest({ plan, apply: false, stateDir, sessionId, out: deps.out, err: deps.err });
		}
		const { Substrate } = await import("../../../mcp-server/src/service.ts");
		const substrate = new Substrate(config);
		const ingest: IngestCall = (input, batchRoots) => substrate.ingestDocs(input, "substrate", batchRoots);
		return runAllMarkdownIngest({ plan, apply: true, stateDir, ingest, sessionId, out: deps.out, err: deps.err });
	} catch (cause) {
		deps.err(`[substrate] docs ingest-all failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
		return 1;
	}
}
