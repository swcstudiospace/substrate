/**
 * A stub of the three corpus routes over a loopback socket, for the CLI tests: one scripted handler per route, a record
 * of what was sent, and builders for answers of the shape the server gives.
 */
import { createHash } from "node:crypto";
import {
	CORPUS_PROTOCOL,
	type GhRunner,
	type CorpusIngestResponse,
	type CorpusPlanResponse,
	type CorpusStatusResponse,
	type IngestStatus,
	type PlanAction,
	type PlanItem,
} from "@substrate/corpus";

export interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	body: unknown;
}

export type Reply = { status: number; body: unknown } | "hang";

export class CorpusStub {
	seen: Seen[] = [];
	/** Handlers keyed `"METHOD /path"`; a route without one answers 404. */
	routes = new Map<string, (seen: Seen) => Reply>();
	readonly server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const raw = await request.text();
			let body: unknown = null;
			try {
				body = raw === "" ? null : JSON.parse(raw);
			} catch {
				body = raw;
			}
			const seen: Seen = {
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				body,
			};
			this.seen.push(seen);
			const reply = this.routes.get(`${seen.method} ${seen.path}`)?.(seen) ?? { status: 404, body: { error: "no route" } };
			if (reply === "hang") return new Promise<Response>(() => undefined);
			return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
		},
	});

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	on(route: string, handler: (seen: Seen) => Reply): this {
		this.routes.set(route, handler);
		return this;
	}

	requests(path: string): Seen[] {
		return this.seen.filter((seen) => seen.path === path);
	}

	stop(): void {
		this.server.stop(true);
	}
}

export function planOf(items: PlanItem[], unchanged = 0): CorpusPlanResponse {
	const counts: Record<PlanAction, number> = { add: 0, change: 0, rename: 0, tombstone: 0, unchanged };
	for (const item of items) counts[item.action] += 1;
	return { protocol: CORPUS_PROTOCOL, items, counts, manifestVersion: 7 };
}

export function ingestOf(results: CorpusIngestResponse["results"]): CorpusIngestResponse {
	const typed: Record<IngestStatus, number> = { ingested: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 };
	for (const result of results) typed[result.status] += 1;
	return { protocol: CORPUS_PROTOCOL, results, counts: typed, manifestVersion: 8 };
}

export function statusOf(): CorpusStatusResponse {
	return {
		protocol: CORPUS_PROTOCOL,
		total: 5,
		active: 4,
		tombstoned: 1,
		byRepo: [{ repo: "Acme/Alpha", active: 4, tombstoned: 1 }],
		byKind: [{ kind: "doc", count: 3 }],
		byTier: [{ tier: 1, count: 4 }],
		lastIngestAt: "2026-10-29T10:00:00.000Z",
		manifestVersion: 9,
	};
}

export interface FakeOwnerRepo {
	files: Record<string, string>;
	/** Mark the API tree as truncated. */
	truncated?: boolean;
}

/** A `gh` that answers the listing, head-commit, tree and blob calls for an owner's repositories (default branch `main`). */
export function fakeGhOwner(repos: Record<string, FakeOwnerRepo>): GhRunner {
	const commit = "d".repeat(40);
	const shaOf = (slug: string, path: string): string => createHash("sha1").update(`${slug}:${path}`).digest("hex");
	return async (args) => {
		if (args[0] === "repo") {
			const listed = Object.keys(repos).map((nameWithOwner) => ({ nameWithOwner, isArchived: false, defaultBranchRef: { name: "main" } }));
			return { code: 0, stdout: JSON.stringify(listed) };
		}
		const route = /^repos\/([^/]+\/[^/]+)\/(commits|git\/trees|git\/blobs)\/(.+)$/.exec(args[args.length - 1] ?? "");
		const slug = route?.[1] ?? "";
		const repo = repos[slug];
		if (route === null || repo === undefined) return { code: 1, stdout: "" };
		if (route[2] === "commits") return { code: 0, stdout: commit };
		if (route[2] === "git/trees") {
			const tree = Object.entries(repo.files).map(([path, content]) => ({ path, type: "blob", mode: "100644", sha: shaOf(slug, path), size: Buffer.byteLength(content) }));
			return { code: 0, stdout: JSON.stringify({ sha: "t".repeat(40), truncated: repo.truncated === true, tree }) };
		}
		for (const [path, content] of Object.entries(repo.files)) {
			if (shaOf(slug, path) === route[3]) {
				return { code: 0, stdout: JSON.stringify({ encoding: "base64", content: Buffer.from(content).toString("base64") }) };
			}
		}
		return { code: 1, stdout: "" };
	};
}
