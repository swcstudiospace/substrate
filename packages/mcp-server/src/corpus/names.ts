/**
 * The one corpus name rule only the server needs. The name of a document (`corpusDocumentName`), its safety check and the
 * rest of the document rules live in `@substrate/corpus`, where the CLI applies the same ones before it sends anything.
 */
import { createHash } from "node:crypto";

/**
 * The id LightRAG gives the document stored under `name`: `doc-` plus the MD5 of the name (`compute_mdhash_id(file_path,
 * prefix="doc-")`, recorded in `planes/lightrag-bulk.ts`). Used only to clear a same-name document the manifest does not know.
 */
export function planeDocumentIdForName(name: string): string {
	return `doc-${createHash("md5").update(name, "utf8").digest("hex")}`;
}
