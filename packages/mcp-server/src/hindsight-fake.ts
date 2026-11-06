/**
 * The recording Hindsight fake for rehearsal (D26-09).
 *
 * Serves the ultrathink-attested bank skeleton over an injected `fetch` and
 * records every request it receives. Tests prove the client against it
 * instead of the deployment; the G1 live probe confirms the deployment
 * speaks the same shapes.
 *
 * Anti-pattern gates: any recall missing the bank path segment cannot route
 * (unrouted requests answer 500, so the call log still shows them), and any
 * retain missing a per-item `document_id` is a 400 — a suite passing against
 * this fake proves no unbanked recall and no unkeyed retain exists.
 *
 * The call log records bearer *presence*, never the value: a credential must
 * not land in a test log.
 */
import type { RecallHit } from "./planes/hindsight.ts";

interface RecordedRequest {
	method: string;
	path: string;
	authed: boolean;
	body: unknown;
}

interface FakeBank {
	mode: string;
	memories: RecallHit[];
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(new DOMException("aborted", "AbortError"));
		return promise;
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		reject(new DOMException("aborted", "AbortError"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function isKeyedItem(item: unknown): item is { document_id: string } & Record<string, unknown> {
	return (
		item !== null &&
		typeof item === "object" &&
		"document_id" in item &&
		typeof item.document_id === "string" &&
		item.document_id.length > 0
	);
}

const BANK_PREFIX = "/v1/default/banks/";

export class HindsightFake {
	readonly requests: RecordedRequest[] = [];
	/** Banks the fake serves, by name. Tests seed or create them. */
	readonly banks = new Map<string, FakeBank>();
	/** `/version` shape: full names the version, minimal omits it (U-01). */
	versionShape: "full" | "minimal" = "full";
	/** Recall shape: bare `{results}` or wrapped `{data: {results}}`. */
	recallShape: "bare" | "wrapped" = "bare";
	/** When set, the next recall answers with this status instead. */
	failRecallWith: number | null = null;
	/** When set, the next retain answers with this status instead. */
	failRetainWith: number | null = null;
	/** When true, deletes answer with an empty 204 like the deployment does. */
	emptyDelete = false;
	/** Per-bank recall latency, for the shared-budget slow-bank proof. */
	recallDelayMs: Record<string, number> = {};
	/** Per-bank recall latency that ignores the caller's abort: only the caller giving up (the brief's cap) leaves that bank out. */
	recallDeafMs: Record<string, number> = {};
	/** Retain latency, for the shutdown-drain proof. */
	retainDelayMs = 0;
	/** Every retained item, in order, with its bank. */
	readonly retains: Array<{ bank: string; item: Record<string, unknown> }> = [];
	/** When set, `GET /v1/default/banks` answers with this status instead. */
	failListWith: number | null = null;
	/** When set, a list page never holds more than this many banks, whatever `limit` asked for (a server that caps pages). */
	listPageCap: number | null = null;
	/** Per-bank `GET {bank}/stats` fields layered over the defaults. */
	statsOverride: Record<string, Record<string, unknown>> = {};
	/** Per-bank last write instants the list and stats report. */
	lastWriteAt: Record<string, string> = {};

	/** Seed a bank in `chunks` mode with recallable memories. */
	seed(bank: string, memories: RecallHit[]): void {
		this.banks.set(bank, { mode: "chunks", memories: [...memories] });
	}

	/** A `fetch` over this fake, for injection into the plane client. */
	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		let body: unknown = null;
		if (typeof init?.body === "string" && init.body.length > 0) {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		const headers = new Headers(init?.headers);
		this.requests.push({ method, path: url.pathname, authed: headers.has("authorization"), body });
		if (method === "GET" && url.pathname === "/health") return json({ status: "healthy", database: "connected" });
		if (method === "GET" && url.pathname === "/version") {
			return this.versionShape === "full"
				? json({ api_version: "0.9.1", features: { recall: true, retain: true } })
				: json({});
		}
		if (method === "GET" && url.pathname === "/v1/default/banks") return this.listBanks(url);
		if (url.pathname.startsWith(BANK_PREFIX)) {
			const rest = url.pathname.slice(BANK_PREFIX.length);
			const slash = rest.indexOf("/");
			const bank = slash === -1 ? rest : rest.slice(0, slash);
			const tail = slash === -1 ? "" : rest.slice(slash);
			if (tail === "/config" && method === "GET") return this.bankConfig(bank);
			if (tail === "" && method === "PUT") return this.createBank(bank);
			if (tail === "/config" && method === "PATCH") return this.patchConfig(bank, body);
			if (tail === "/memories" && method === "POST") return this.retain(bank, body);
			if (tail === "/memories/recall" && method === "POST") return this.recall(bank, body, init?.signal);
			if (tail.startsWith("/documents/") && method === "GET") return this.getDocument(bank, tail.slice("/documents/".length));
			if (tail === "/stats" && method === "GET") return this.bankStats(bank);
			if (tail.startsWith("/documents/") && method === "DELETE") return this.deleteDocument(bank, tail.slice("/documents/".length));
			if (tail.startsWith("/documents/") && method === "PATCH") return this.patchDocument(bank, tail.slice("/documents/".length), body);
			if (tail === "" && method === "DELETE") return this.deleteBank(bank);
		}
		return json({ error: `fake has no route for ${method} ${url.pathname}` }, 500);
	};

	/** Every recall request body received, in order. */
	recalls(): unknown[] {
		return this.requests.filter((request) => request.path.endsWith("/memories/recall")).map((request) => request.body);
	}

	/** Every retain request body received, in order. */
	retainBodies(): unknown[] {
		return this.requests.filter((request) => request.path.endsWith("/memories") && request.method === "POST").map((request) => request.body);
	}

	private bankConfig(bank: string): Response {
		const found = this.banks.get(decodeURIComponent(bank));
		if (!found) return json({ detail: "bank not found" }, 404);
		return json({ config: { retain_extraction_mode: found.mode } });
	}

	private createBank(bank: string): Response {
		const name = decodeURIComponent(bank);
		if (!this.banks.has(name)) this.banks.set(name, { mode: "server-default", memories: [] });
		return json({ bank_id: name }, 201);
	}

	private patchConfig(bank: string, body: unknown): Response {
		const found = this.banks.get(decodeURIComponent(bank));
		if (!found) return json({ detail: "bank not found" }, 404);
		if (body !== null && typeof body === "object" && "updates" in body) {
			const updates = body.updates;
			if (updates !== null && typeof updates === "object" && "retain_extraction_mode" in updates && typeof updates.retain_extraction_mode === "string") {
				found.mode = updates.retain_extraction_mode;
			}
		}
		return json({ config: { retain_extraction_mode: found.mode } });
	}

	private async retain(bank: string, body: unknown): Promise<Response> {
		if (this.failRetainWith !== null) return json({ error: "injected failure" }, this.failRetainWith);
		if (this.retainDelayMs > 0) await sleep(this.retainDelayMs, null);
		const name = decodeURIComponent(bank);
		if (!this.banks.has(name)) return json({ detail: "bank not found" }, 404);
		if (body === null || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items) || body.items.length === 0) {
			return json({ detail: "items required" }, 400);
		}
		for (const item of body.items) {
			if (!isKeyedItem(item)) return json({ detail: "document_id required per item" }, 400);
		}
		for (const item of body.items) {
			if (!isKeyedItem(item)) continue;
			this.retains.push({ bank: name, item: { ...item } });
			const memories = this.banks.get(name)?.memories ?? [];
			const at = memories.findIndex((memory) => memory.document_id === item.document_id);
			const content = "content" in item && typeof item.content === "string" ? item.content : "";
			const tags = "tags" in item && Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [];
			const metadata: Record<string, unknown> = {};
			if ("metadata" in item && item.metadata !== null && typeof item.metadata === "object") {
				for (const [key, value] of Object.entries(item.metadata)) {
					if (typeof value === "string") metadata[key] = value;
				}
			}
			const stored: RecallHit = { id: item.document_id, text: content, document_id: item.document_id, tags, metadata };
			if (at === -1) memories.push(stored);
			else memories[at] = stored;
		}
		return json({ success: true, bank_id: name, items_count: body.items.length, async: false });
	}

	private async recall(bank: string, body: unknown, signal?: AbortSignal | null): Promise<Response> {
		if (this.failRecallWith !== null) return json({ error: "injected failure" }, this.failRecallWith);
		const name = decodeURIComponent(bank);
		const delay = this.recallDelayMs[name] ?? 0;
		if (delay > 0) await sleep(delay, signal);
		const deaf = this.recallDeafMs[name] ?? 0;
		if (deaf > 0) await sleep(deaf, null);
		const found = this.banks.get(name);
		if (!found) return json({ detail: "bank not found" }, 404);
		if (body === null || typeof body !== "object" || !("query" in body) || typeof body.query !== "string" || body.query.length === 0) {
			return json({ detail: "query required" }, 400);
		}
		const results = found.memories.map((memory) => ({ ...memory }));
		return this.recallShape === "wrapped" ? json({ data: { results } }) : json({ results });
	}

	private getDocument(bank: string, id: string): Response {
		const found = this.banks.get(decodeURIComponent(bank))?.memories.find((memory) => memory.document_id === decodeURIComponent(id));
		if (!found) return json({ detail: "document not found" }, 404);
		return json({ ...found });
	}

	private deleteDocument(bank: string, id: string): Response {
		const memories = this.banks.get(decodeURIComponent(bank))?.memories;
		if (!memories) return json({ detail: "bank not found" }, 404);
		const at = memories.findIndex((memory) => memory.document_id === decodeURIComponent(id));
		if (at === -1) return json({ detail: "document not found" }, 404);
		memories.splice(at, 1);
		if (this.emptyDelete) return new Response(null, { status: 204 });
		return json({ success: true });
	}

	private patchDocument(bank: string, id: string, body: unknown): Response {
		const memory = this.banks.get(decodeURIComponent(bank))?.memories.find((entry) => entry.document_id === decodeURIComponent(id));
		if (!memory) return json({ detail: "document not found" }, 404);
		if (body !== null && typeof body === "object" && "tags" in body && Array.isArray(body.tags)) {
			memory.tags = body.tags.filter((tag): tag is string => typeof tag === "string");
		}
		return json({ ...memory });
	}

	private deleteBank(bank: string): Response {
		if (!this.banks.delete(decodeURIComponent(bank))) return json({ detail: "bank not found" }, 404);
		if (this.emptyDelete) return new Response(null, { status: 204 });
		return json({ success: true });
	}

	/** `GET /v1/default/banks?limit&offset`: every bank in map order, paged like the deployment. */
	private listBanks(url: URL): Response {
		if (this.failListWith !== null) return json({ error: "injected failure" }, this.failListWith);
		const limit = Math.min(this.listPageCap ?? Number.POSITIVE_INFINITY, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
		const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
		const all = [...this.banks.entries()].map(([bank, state]) => ({
			bank_id: bank,
			name: bank,
			fact_count: state.memories.length,
			last_write_at: this.lastWriteAt[bank] ?? null,
		}));
		return json({ banks: all.slice(offset, offset + limit), total: all.length });
	}

	/** `GET {bank}/stats`: the operation backlog; a test overrides it per bank. */
	private bankStats(bank: string): Response {
		const name = decodeURIComponent(bank);
		if (!this.banks.has(name)) return json({ detail: "bank not found" }, 404);
		return json({
			pending_operations: 0,
			failed_operations: 0,
			last_memory_write_at: this.lastWriteAt[name] ?? null,
			...(this.statsOverride[name] ?? {}),
		});
	}
}
