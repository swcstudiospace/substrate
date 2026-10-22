/**
 * An in-memory `PlanningFs` for the planning tests: files, symlinks and recorded reads. It never
 * touches the disk. Paths are absolute POSIX strings; the test root is `/repo`.
 *
 * `openRead` follows the same contract as the production adapter: the real path is handed to
 * `accept` before any byte is returned, a refusal returns nothing, and at most `limit` bytes come back.
 * The counters let a test prove what left the tree: which real files had their bytes returned, and
 * the largest read the index asked for.
 */
import { createHash } from "node:crypto";
import type { DirEntry, OpenResult, PlanningFs, Probe } from "./index.ts";

export const TREE_ROOT = "/repo";

type Resolved = { state: "absent" } | { state: "dangling" } | { state: "resolved"; real: string };

export class FakeTree implements PlanningFs {
	/** Every path a read was asked for (`openRead` or `readFile`), in order. */
	readonly reads: string[] = [];
	/** Every directory a listing was asked for, in order. */
	readonly listed: string[] = [];
	/** Real paths whose bytes were returned to the caller, in order. A refused path never appears here. */
	readonly returnedFrom: string[] = [];
	/** The largest number of bytes any single `openRead` returned. */
	largestReturned = 0;
	/** Paths whose open throws EACCES. */
	readonly denied = new Set<string>();
	/** Directories whose listing throws EACCES. */
	readonly deniedListings = new Set<string>();
	/** Called with the path just before it is resolved for `openRead`, so a test can swap a link in between. */
	beforeOpen: ((path: string) => void) | null = null;
	private readonly files = new Map<string, Uint8Array>();

	constructor(
		files: Record<string, string | Uint8Array>,
		private readonly links: Record<string, string> = {},
	) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
		}
	}

	/** Most probes in flight at once. A sequential walk keeps this at one; the concurrency bound shows here. */
	maxProbesInFlight = 0;
	private probesInFlight = 0;
	/** Every path probed, in order. */
	readonly probed: string[] = [];

	async probe(path: string): Promise<Probe> {
		this.probed.push(path);
		this.probesInFlight += 1;
		this.maxProbesInFlight = Math.max(this.maxProbesInFlight, this.probesInFlight);
		try {
			// Yield once so that concurrent callers overlap, as they would on a real filesystem.
			await Promise.resolve();
			const found = this.resolve(path);
			if (found.state !== "resolved") return found;
			const isFile = this.files.has(found.real);
			return { state: "present", real: found.real, isFile, isDir: !isFile };
		} finally {
			this.probesInFlight -= 1;
		}
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		this.listed.push(path);
		if (this.deniedListings.has(path)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		const found = this.resolve(path);
		if (found.state !== "resolved" || this.files.has(found.real)) return null;
		const dir = found.real;
		const prefix = `${dir}/`;
		const names = new Set<string>();
		for (const key of [...this.files.keys(), ...Object.keys(this.links)]) {
			if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] ?? "");
		}
		return [...names].map((name) => ({ name, kind: this.kindOf(`${dir}/${name}`) }));
	}

	async statFile(path: string): Promise<{ isFile: boolean; size: number } | null> {
		const found = this.resolve(path);
		if (found.state !== "resolved") return null;
		const content = this.files.get(found.real);
		return content === undefined ? { isFile: false, size: 0 } : { isFile: true, size: content.byteLength };
	}

	async readFile(path: string): Promise<Uint8Array> {
		this.reads.push(path);
		if (this.denied.has(path)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		const found = this.resolve(path);
		const content = found.state === "resolved" ? this.files.get(found.real) : undefined;
		if (content === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
		return content;
	}

	async openRead(path: string, limit: number, accept: (real: string) => boolean): Promise<OpenResult> {
		this.reads.push(path);
		this.beforeOpen?.(path);
		if (this.denied.has(path)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		const found = this.resolve(path);
		if (found.state !== "resolved") return { state: "absent" };
		if (!accept(found.real)) return { state: "refused" };
		const content = this.files.get(found.real);
		if (content === undefined) return { state: "opened", real: found.real, isFile: false, bytes: new Uint8Array(0) };
		const bytes = content.slice(0, limit);
		this.largestReturned = Math.max(this.largestReturned, bytes.byteLength);
		this.returnedFrom.push(found.real);
		return { state: "opened", real: found.real, isFile: true, bytes };
	}

	/** Replace a file's bytes, as a file that changed on disk would. */
	setContent(path: string, content: string): void {
		this.files.set(path, new TextEncoder().encode(content));
	}

	sha256(bytes: Uint8Array): string {
		return createHash("sha256").update(bytes).digest("hex");
	}

	/** Follows links (at most 16 hops) to a file or directory that exists, or says why it does not. */
	private resolve(path: string): Resolved {
		let current = path;
		for (let hop = 0; current in this.links; hop++) {
			if (hop === 16) return { state: "dangling" };
			current = this.links[current] ?? "";
		}
		if (this.exists(current)) return { state: "resolved", real: current };
		return path in this.links ? { state: "dangling" } : { state: "absent" };
	}

	private exists(path: string): boolean {
		return this.files.has(path) || this.isDir(path);
	}

	private isDir(path: string): boolean {
		const prefix = `${path}/`;
		return [...this.files.keys(), ...Object.keys(this.links)].some((key) => key.startsWith(prefix));
	}

	private kindOf(path: string): DirEntry["kind"] {
		const found = this.resolve(path);
		if (found.state === "dangling") return "broken";
		if (found.state === "absent") return "other";
		return this.files.has(found.real) ? "file" : "dir";
	}
}
