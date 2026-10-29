/**
 * `substrate corpus verify`, offline half (v1.7 phase 69): does an inclusion proof file hold?
 *
 * The check needs no network and no server. It recomputes the document's leaf from the file's `repo`, `documentPath` and `sha256`
 * (the leaf encoding of `@substrate/corpus`), requires it to equal the file's `leaf`, then checks the audit path with the
 * ledger's own RFC 6962 verifier against the file's `root`. A changed repo, path, hash, leaf, sibling, index or root makes it
 * invalid. What it proves is that the document was in the manifest that has that root; that the root was recorded in the ledger
 * and anchored on devnet is the online half (`GET /corpus/anchor`), which `conflictWith` judges here.
 *
 * The tree size is not authenticated by the root alone (see `verifyMerkleProofHex`), so offline it is only as good as the file;
 * the online check compares it with the count of the anchored root event.
 */
import { corpusLeafHex, type CorpusAnchorResponse, type CorpusProofResponse } from "@substrate/corpus";
import { verifyMerkleProofHex } from "../../../ledger/src/merkle-proof.ts";

export type OfflineVerdict = { valid: true } | { valid: false; reason: string };

/** The largest proof file `verify` reads. A real proof is a few kilobytes (a path of at most 64 hashes and one document's names). */
export const MAX_PROOF_FILE_BYTES = 1_000_000;

function invalid(reason: string): OfflineVerdict {
	return { valid: false, reason };
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Whether the proof holds on its own. Never throws: a malformed file is an invalid one, with the reason. */
export function verifyProofOffline(proof: CorpusProofResponse): OfflineVerdict {
	let leaf: string;
	try {
		leaf = corpusLeafHex(proof.repo, proof.documentPath, proof.sha256);
	} catch (cause) {
		return invalid(`the document cannot be encoded as a leaf: ${messageOf(cause)}`);
	}
	if (leaf !== proof.leaf) return invalid("the leaf is not the leaf of this repo, path and sha256");
	try {
		const holds = verifyMerkleProofHex(leaf, { index: proof.index, size: proof.treeSize, path: proof.path }, proof.root);
		return holds ? { valid: true } : invalid("the audit path does not lead from this leaf to the root");
	} catch (cause) {
		return invalid(`the proof is malformed: ${messageOf(cause)}`);
	}
}

/**
 * Why an anchor answer contradicts the proof, or null when it does not. `unanchored`, `pending` and `unverified` do not
 * contradict it: they say the root is not (yet, or provably) in an anchored hour. A `mismatch` does, and so does an answer about
 * another root or a root event that covers a different number of documents than the proof's tree has.
 */
export function conflictWith(proof: CorpusProofResponse, anchor: CorpusAnchorResponse): string | null {
	if (anchor.root !== proof.root) return "the server answered about a different root";
	if (anchor.status === "mismatch") return "the ledger and the chain disagree about the hour this root sits in";
	if (anchor.count !== null && anchor.count !== proof.treeSize) {
		return `the recorded root event covers ${anchor.count} documents, the proof's tree has ${proof.treeSize}`;
	}
	return null;
}
