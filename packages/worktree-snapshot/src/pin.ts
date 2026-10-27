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

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { SnapshotPolicyError } from "./errors.ts";
import { isValidId } from "./paths.ts";
import { git, gitText, gitTry, type RepoContext } from "./runner.ts";
import { assertObjectId, assertTreeExists, snapshotOfTree } from "./tree.ts";
import type { PinResult, Snapshot } from "./types.ts";

export const REF_ROOT = "refs/substrate";

export type PinNamespace = "checkpoints" | "safety" | "restore-target";

/** The largest canonical-JSON metadata a pin carries: it lives in the commit message, next to the ref it describes. */
export const MAX_METADATA_BYTES = 4096;

/** The commit-message trailer that carries a pin's metadata as one line of canonical JSON. */
export const METADATA_TRAILER = "Substrate-Checkpoint-Metadata";

const MAX_METADATA_DEPTH = 16;

function canonicalValue(value: unknown, depth: number): string {
	if (depth > MAX_METADATA_DEPTH) throw new SnapshotPolicyError(`metadata nests deeper than ${MAX_METADATA_DEPTH} levels`);
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new SnapshotPolicyError("metadata numbers must be finite");
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map((item) => canonicalValue(item, depth + 1)).join(",")}]`;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				throw new SnapshotPolicyError("metadata must hold plain JSON values only");
			}
			const record = value as Record<string, unknown>;
			const parts: string[] = [];
			for (const key of Object.keys(record).sort()) {
				const inner = record[key];
				// An undefined property is absent in JSON; skipping it keeps the encoding stable across a round trip.
				if (inner === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalValue(inner, depth + 1)}`);
			}
			return `{${parts.join(",")}}`;
		}
		default:
			throw new SnapshotPolicyError("metadata must hold plain JSON values only");
	}
}

/** Canonical JSON (sorted keys, no whitespace) of a metadata object, refused above `MAX_METADATA_BYTES`. */
export function encodeMetadata(metadata: unknown): string {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
		throw new SnapshotPolicyError("metadata must be a JSON object");
	}
	const json = canonicalValue(metadata, 0);
	if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
		throw new SnapshotPolicyError(`metadata exceeds ${MAX_METADATA_BYTES} bytes of canonical JSON`);
	}
	return json;
}

const IDENTITY = {
	name: "Substrate Snapshot",
	email: "snapshot@substrate.invalid",
};

/**
 * A pin ref. Checkpoints live in a per-worktree scope, `refs/substrate/checkpoints/<scope>/<id>`,
 * because linked worktrees of one repository share `refs/`: without a scope every worktree would list,
 * read and restore the others' checkpoints. `<scope>` is `w-` and 16 hex digits of the SHA-256 of
 * this worktree's git directory relative to the repository's common git directory (empty for the
 * main worktree, `worktrees/<name>` for a linked one), so it is stable across calls and across a move
 * of the repository, distinct between linked worktrees, and one constant for the main worktree.
 * A checkpoint ref WITHOUT a scope (`refs/substrate/checkpoints/<id>`) was made before scoping; only
 * the main worktree owns those, and they are read in place, never renamed.
 */
const PINNED_REF_RE =
	/^refs\/substrate\/(?:(?:safety|restore-target)\/|checkpoints\/(?:w-[0-9a-f]{16}\/)?)[A-Za-z0-9._-]{8,64}$/;

const SCOPE_RE = /^w-[0-9a-f]{16}$/;

type WorktreeScope = { scope: string; isMain: boolean };

async function worktreeScope(ctx: RepoContext): Promise<WorktreeScope> {
	const common = realpathSync(resolve(ctx.root, await gitText(ctx, ["rev-parse", "--git-common-dir"])));
	const relativeGitDir = relative(common, ctx.gitDir);
	const scope = `w-${createHash("sha256").update(relativeGitDir).digest("hex").slice(0, 16)}`;
	return { scope, isMain: relativeGitDir === "" };
}

/** The ref a pin of `namespace`/`id` lives at in this worktree; only checkpoints are scoped. */
export async function pinRef(ctx: RepoContext, namespace: PinNamespace, id: string): Promise<string> {
	if (!isValidId(id)) throw new SnapshotPolicyError("id must match ^[A-Za-z0-9._-]{8,64}$");
	if (namespace !== "checkpoints") return `${REF_ROOT}/${namespace}/${id}`;
	return `${REF_ROOT}/checkpoints/${(await worktreeScope(ctx)).scope}/${id}`;
}

/** The flat ref of a safety or restore-target pin (their ids are unique per restore and live in this worktree's journal). */
export function refFor(namespace: Exclude<PinNamespace, "checkpoints">, id: string): string {
	if (!isValidId(id)) throw new SnapshotPolicyError("id must match ^[A-Za-z0-9._-]{8,64}$");
	return `${REF_ROOT}/${namespace}/${id}`;
}

/** Refuse any pin ref that is malformed or is another worktree's checkpoint. */
async function assertOwnedPinRef(ctx: RepoContext, ref: string): Promise<void> {
	if (!PINNED_REF_RE.test(ref)) throw new SnapshotPolicyError("not a substrate pin ref");
	if (!ref.startsWith(CHECKPOINT_REF_PREFIX)) return;
	const own = await worktreeScope(ctx);
	const segments = ref.slice(CHECKPOINT_REF_PREFIX.length).split("/");
	const owned = segments.length === 2 ? segments[0] === own.scope : own.isMain;
	if (!owned) throw new SnapshotPolicyError("that checkpoint belongs to another worktree of this repository");
}

async function resolveRefTree(ctx: RepoContext, ref: string): Promise<string | null> {
	const result = await gitTry(ctx, ["rev-parse", "--verify", "-q", `${ref}^{tree}`]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

/**
 * Pin a tree under `refs/substrate/<namespace>/<id>`. Idempotent: pinning the same tree again under
 * the same id returns the existing commit; a different tree under an existing id is refused.
 * `metadata`, when given, is canonical JSON from `encodeMetadata`; it is written once, with the
 * commit, and an idempotent re-pin keeps the metadata the pin was created with.
 */
export async function pinTree(
	ctx: RepoContext,
	namespace: PinNamespace,
	id: string,
	tree: string,
	metadata?: string,
): Promise<PinResult> {
	const ref = await pinRef(ctx, namespace, id);
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
	const message =
		metadata === undefined ? `substrate ${namespace} ${id}` : `substrate ${namespace} ${id}\n\n${METADATA_TRAILER}: ${metadata}`;
	const commit = await gitText(ctx, ["commit-tree", tree, "-m", message], { env });
	assertObjectId(commit, "commit-tree output");
	// The empty old value makes update-ref fail rather than overwrite a ref created concurrently.
	await git(ctx, ["update-ref", ref, commit, ""]);
	return { ref, commit };
}

export async function deletePin(ctx: RepoContext, ref: string): Promise<void> {
	await assertOwnedPinRef(ctx, ref);
	await git(ctx, ["update-ref", "-d", ref]);
}

/**
 * A Snapshot rebuilt from a pinned ref. `headCommit` and `branch` are null and `skipped` is empty:
 * a pin stores only the tree.
 */
export async function readPinnedSnapshotIn(ctx: RepoContext, ref: string): Promise<Snapshot> {
	await assertOwnedPinRef(ctx, ref);
	const tree = await resolveRefTree(ctx, ref);
	if (tree === null) throw new SnapshotPolicyError(`${ref} does not exist`);
	return snapshotOfTree(ctx, tree, { skipped: [], headCommit: null, branch: null });
}

/** A pinned checkpoint as `listPinned` reports it. */
export type PinnedCheckpoint = {
	/** The id the ref was pinned under (the last segment of `ref`). */
	id: string;
	ref: string;
	commit: string;
	tree: string;
	/** The pin commit's committer date (the injected clock at pin time), ISO 8601. */
	createdAt: string;
	/** The parsed metadata object, or null when the pin has none or its trailer is corrupt. */
	metadata: Record<string, unknown> | null;
	/** Why `metadata` is null although the pin has a trailer (or the ref is not a readable commit); null otherwise. */
	metadataError: string | null;
};

const CHECKPOINT_REF_PREFIX = `${REF_ROOT}/checkpoints/`;
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

function parseMetadataTrailer(body: string): { metadata: Record<string, unknown> | null; error: string | null } {
	const prefix = `${METADATA_TRAILER}: `;
	const lines = body.split("\n").filter((line) => line.startsWith(prefix));
	if (lines.length === 0) return { metadata: null, error: null };
	if (lines.length > 1) return { metadata: null, error: "the metadata trailer appears more than once" };
	const raw = (lines[0] ?? "").slice(prefix.length);
	if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) {
		return { metadata: null, error: `the metadata trailer exceeds ${MAX_METADATA_BYTES} bytes` };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { metadata: null, error: "the metadata trailer is not valid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { metadata: null, error: "the metadata trailer is not a JSON object" };
	}
	return { metadata: value as Record<string, unknown>, error: null };
}

/**
 * Every checkpoint of THIS worktree under `refs/substrate/checkpoints/`, sorted by ref name, with its
 * parsed metadata: the ones in this worktree's scope, plus, for the main worktree only, the unscoped
 * ones made before scoping. Another worktree's checkpoints are never listed. A corrupt trailer is
 * reported on that entry (`metadata: null`, `metadataError`), never thrown: one damaged pin must not
 * hide the others, and the pinned refs are the local checkpoint registry.
 */
export async function listPinnedIn(ctx: RepoContext): Promise<PinnedCheckpoint[]> {
	const own = await worktreeScope(ctx);
	const format = ["%(refname)", "%(objectname)", "%(tree)", "%(committerdate:unix)", "%(contents:body)"].join("%1f") + "%1e";
	const output = (await git(ctx, ["for-each-ref", `--format=${format}`, "--sort=refname", CHECKPOINT_REF_PREFIX])).toString("utf8");
	const entries: PinnedCheckpoint[] = [];
	for (const record of output.split(RECORD_SEPARATOR)) {
		// for-each-ref ends each record with a newline, so every record after the first starts with one.
		const text = record.replace(/^\n/, "");
		if (text.length === 0) continue;
		const fields = text.split(FIELD_SEPARATOR);
		if (fields.length !== 5) throw new SnapshotPolicyError("unexpected git for-each-ref output while listing checkpoints");
		const [ref = "", commit = "", tree = "", unix = "", body = ""] = fields;
		const rest = ref.slice(CHECKPOINT_REF_PREFIX.length);
		const segments = rest.split("/");
		const id = segments[segments.length - 1] ?? "";
		if (!ref.startsWith(CHECKPOINT_REF_PREFIX) || segments.length > 2 || !isValidId(id)) continue;
		if (segments.length === 2) {
			// A scoped pin is ours only in our own scope; a malformed or foreign scope is not a checkpoint of ours.
			if (!SCOPE_RE.test(segments[0] ?? "") || segments[0] !== own.scope) continue;
		} else if (!own.isMain) continue;
		const seconds = Number(unix);
		if (tree === "" || !Number.isFinite(seconds)) {
			entries.push({
				id,
				ref,
				commit,
				tree,
				createdAt: new Date(0).toISOString(),
				metadata: null,
				metadataError: "the ref does not point at a readable commit",
			});
			continue;
		}
		const parsed = parseMetadataTrailer(body);
		entries.push({
			id,
			ref,
			commit,
			tree,
			createdAt: new Date(seconds * 1000).toISOString(),
			metadata: parsed.metadata,
			metadataError: parsed.error,
		});
	}
	return entries;
}
