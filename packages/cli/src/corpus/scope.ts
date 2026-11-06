/**
 * `substrate corpus` under the repository registry (phase 72).
 *
 * A corpus command runs git in each `--root` it walks, in each `--repo` directory it hooks, and names each `--repo` it reads.
 * Those are the targets the registry must place before the command runs: a root or hook directory must lie inside a registered
 * directory; a named repository must be registered, and a `.git` nested under a registered directory is refused (the strict rule). The server, unlike this command, requires `SUBSTRATE_REPO_SCOPES` when the registry is set. Scoping off (`SUBSTRATE_REPO_REGISTRY` unset or blank) changes nothing.
 *
 * A refusal exits 2 with the reason and runs no git: `runCorpus` calls {@link corpusScopeRefusal} before any dispatch. The local
 * commands act as surface `claude-code`, the surface they post as, the same as `substrate worktree`. A refusal is audited as a
 * ledger warning that names the reason and a digest of the requested value; the write is fail-open.
 */
import { resolve } from "node:path";
import {
	localPathGate,
	localRegistryScope,
	localRepoGate,
	REPO_REFUSAL_MESSAGES,
	repoRefusalPayload,
	type RepoGate,
	type RepoScope,
} from "../../../mcp-server/src/repo-scope.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import { LOCAL_SURFACE } from "../worktree/scope.ts";

/** A value a corpus command would run git in or hook (`path`), or a repository it names (`repo`). */
export type LocalTarget = { readonly path: string } | { readonly repo: string };

/** Writes one audit event; a refusal calls it fail-open. */
export type LocalAudit = (event: EventInput) => Promise<unknown>;

function gateOf(scope: RepoScope, target: LocalTarget): RepoGate {
	return "path" in target ? localPathGate(scope, LOCAL_SURFACE, resolve(target.path)) : localRepoGate(scope, LOCAL_SURFACE, target.repo);
}

/**
 * The refusal for `route` over `targets`, or null when the command may run. Called once, before any git call. An unparsable
 * registry refuses everything (it cannot place any target); an unset registry refuses nothing.
 */
export async function corpusScopeRefusal(route: string, env: Record<string, string | undefined>, targets: readonly LocalTarget[], audit?: LocalAudit): Promise<string | null> {
	const parsed = localRegistryScope(env);
	if (!parsed.ok) return `${parsed.problem}; nothing was run\n`;
	const scope = parsed.value;
	if (scope === null) return null;
	for (const target of targets) {
		const gate = gateOf(scope, target);
		if (gate.ok) continue;
		const requested = "path" in target ? target.path : target.repo;
		try {
			if (audit !== undefined) await audit({ surface: LOCAL_SURFACE, kind: "warning", summary: `repo request refused: ${gate.reason}`, payload: repoRefusalPayload(route, gate.reason, requested) });
		} catch {
			// Fail-open: a ledger that is down never lets a refusal turn into a run.
		}
		return `refused: ${requested}: ${REPO_REFUSAL_MESSAGES[gate.reason]}; nothing was run\n`;
	}
	return null;
}

/**
 * Whether a local git read may run in `cwd`. Unset registry: yes, as before. Set: only inside a registered directory the local
 * surface is granted. A malformed registry: no.
 */
export function localGitPermitted(env: Record<string, string | undefined>, cwd: string): boolean {
	const parsed = localRegistryScope(env);
	if (!parsed.ok) return false;
	return parsed.value === null || gateOf(parsed.value, { path: cwd }).ok;
}
