/**
 * Making snapshot objects durable.
 *
 * A tree that no ref points to is eligible for `git gc`. Pinning wraps the tree in a parentless
 * commit with a FIXED identity (so the commit is a pure function of the tree, the message and the
 * injected clock) and points `refs/substrate/<namespace>/<id>` at it.
 *
 * WARNING: a snapshot tree can contain untracked files (and `.planning/` notes that are gitignored
 * on purpose). Never run `git push --mirror`, `git push --all` or any refspec that matches
 * `refs/substrate/*` from a repository that holds pins, and do not add `refs/substrate` to a fetch
 * or push refspec: that would publish snapshot contents. Git does not fetch or push this
 * namespace by default.
 */

import { SnapshotPolicyError } from "./errors.ts";
import { isValidId } from "./paths.ts";
import { git, gitText, gitTry, type RepoContext } from "./runner.ts";
import { assertObjectId, assertTreeExists, snapshotOfTree } from "./tree.ts";
import type { PinResult, Snapshot } from "./types.ts";

export const REF_ROOT = "refs/substrate";

export type PinNamespace = "checkpoints" | "safety" | "restore-target";

const IDENTITY = {
	name: "Substrate Snapshot",
	email: "snapshot@substrate.invalid",
};

const PINNED_REF_RE = /^refs\/substrate\/(?:checkpoints|safety|restore-target)\/[A-Za-z0-9._-]{8,64}$/;

export function refFor(namespace: PinNamespace, id: string): string {
	if (!isValidId(id)) throw new SnapshotPolicyError("id must match ^[A-Za-z0-9._-]{8,64}$");
	return `${REF_ROOT}/${namespace}/${id}`;
}

async function resolveRefTree(ctx: RepoContext, ref: string): Promise<string | null> {
	const result = await gitTry(ctx, ["rev-parse", "--verify", "-q", `${ref}^{tree}`]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

/**
 * Pin a tree under `refs/substrate/<namespace>/<id>`. Idempotent: pinning the same tree again under
 * the same id returns the existing commit; a different tree under an existing id is refused.
 */
export async function pinTree(ctx: RepoContext, namespace: PinNamespace, id: string, tree: string): Promise<PinResult> {
	const ref = refFor(namespace, id);
	await assertTreeExists(ctx, tree);
	const existing = await resolveRefTree(ctx, ref);
	if (existing !== null) {
		if (existing !== tree) {
			throw new SnapshotPolicyError(`${ref} already pins a different tree; ids must be unique per snapshot`);
		}
		return { ref, commit: await gitText(ctx, ["rev-parse", "--verify", ref]) };
	}
	const date = `${Math.floor(ctx.now().getTime() / 1000)} +0000`;
	const env = {
		GIT_AUTHOR_NAME: IDENTITY.name,
		GIT_AUTHOR_EMAIL: IDENTITY.email,
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: IDENTITY.name,
		GIT_COMMITTER_EMAIL: IDENTITY.email,
		GIT_COMMITTER_DATE: date,
	};
	const commit = await gitText(ctx, ["commit-tree", tree, "-m", `substrate ${namespace} ${id}`], { env });
	assertObjectId(commit, "commit-tree output");
	// The empty old value makes update-ref fail rather than overwrite a ref created concurrently.
	await git(ctx, ["update-ref", ref, commit, ""]);
	return { ref, commit };
}

export async function deletePin(ctx: RepoContext, ref: string): Promise<void> {
	if (!PINNED_REF_RE.test(ref)) throw new SnapshotPolicyError("not a substrate pin ref");
	await git(ctx, ["update-ref", "-d", ref]);
}

/**
 * A Snapshot rebuilt from a pinned ref. `headCommit` and `branch` are null and `skipped` is empty:
 * a pin stores only the tree.
 */
export async function readPinnedSnapshotIn(ctx: RepoContext, ref: string): Promise<Snapshot> {
	if (!PINNED_REF_RE.test(ref)) throw new SnapshotPolicyError("not a substrate pin ref");
	const tree = await resolveRefTree(ctx, ref);
	if (tree === null) throw new SnapshotPolicyError(`${ref} does not exist`);
	return snapshotOfTree(ctx, tree, { skipped: [], headCommit: null, branch: null });
}
