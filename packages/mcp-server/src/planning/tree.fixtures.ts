/**
 * An in-memory `PlanningFs` for the planning tests: files, symlinks and recorded reads. It never
 * touches the disk. Paths are absolute POSIX strings; the test root is `/repo`.
 */
import { createHash } from "node:crypto";
import type { DirEntry, PlanningFs } from "./index.ts";

export const TREE_ROOT = "/repo";

export class FakeTree implements PlanningFs {
	/** Every path `readFile` was asked for, in order. */
	readonly reads: string[] = [];
	/** Paths whose `readFile` throws EACCES. */
	readonly denied = new Set<string>();
	private readonly files = new Map<string, Uint8Array>();

	constructor(
		files: Record<string, string | Uint8Array>,
		private readonly links: Record<string, string> = {},
	) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
		}
	}

	async realpath(path: string): Promise<string | null> {
		return this.resolve(path);
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		const dir = this.resolve(path);
		if (dir === null || this.files.has(dir)) return null;
		const prefix = `${dir}/`;
		const names = new Set<string>();
		for (const key of [...this.files.keys(), ...Object.keys(this.links)]) {
			if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] ?? "");
		}
		return [...names].map((name) => ({ name, kind: this.kindOf(`${dir}/${name}`) }));
	}

	async statFile(path: string): Promise<{ isFile: boolean; size: number } | null> {
		const target = this.resolve(path);
		if (target === null) return null;
		const content = this.files.get(target);
		return content === undefined ? { isFile: false, size: 0 } : { isFile: true, size: content.byteLength };
	}

	async readFile(path: string): Promise<Uint8Array> {
		this.reads.push(path);
		if (this.denied.has(path)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		const target = this.resolve(path);
		const content = target === null ? undefined : this.files.get(target);
		if (content === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
		return content;
	}

	sha256(bytes: Uint8Array): string {
		return createHash("sha256").update(bytes).digest("hex");
	}

	private resolve(path: string): string | null {
		let current = path;
		for (let hop = 0; current in this.links; hop++) {
			if (hop === 16) return null;
			current = this.links[current] ?? "";
		}
		return this.exists(current) ? current : null;
	}

	private exists(path: string): boolean {
		return this.files.has(path) || this.isDir(path);
	}

	private isDir(path: string): boolean {
		const prefix = `${path}/`;
		return [...this.files.keys(), ...Object.keys(this.links)].some((key) => key.startsWith(prefix));
	}

	private kindOf(path: string): DirEntry["kind"] {
		const target = this.resolve(path);
		if (target === null) return "broken";
		return this.files.has(target) ? "file" : "dir";
	}
}
