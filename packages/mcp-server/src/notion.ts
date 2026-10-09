/**
 * Notion REST client for the Issue-row mirror.
 *
 * Property types are read from each page itself, so a value is shaped for the
 * type the row really has rather than a pinned schema. Every failure is thrown
 * as a NotionError for the mirror to turn into a warning event (D-02); its
 * message carries a status and at most 200 characters of the response body,
 * never the key or a request header.
 *
 * The configured NOTION_API_KEY is a personal access token with the owner's
 * whole-workspace reach, so the client refuses to read types from, or write
 * to, any page that is not a row of the Agent Task Graph data source: every
 * PATCH is preceded by a GET that checks the page's parent.
 */

export const NOTION_VERSION = "2025-09-03";

/**
 * The only properties substrate may write on an Issue row. PR URL, PR #,
 * PR State, Repo and Branch belong to ultrathink-sync (D-07); a write naming
 * any of them — or anything else — is refused before a request is sent.
 */
export const NOTION_WRITABLE = ["Agent", "Status", "Linear State", "Completed"] as const;

const DEFAULT_TIMEOUT_MS = 5000;
export const NOTION_API_URL = "https://api.notion.com/v1";
const BODY_LIMIT = 200;

export class NotionError extends Error {
	constructor(
		message: string,
		/** The HTTP status, or null when no response arrived or no request was sent. */
		readonly status: number | null = null,
	) {
		super(message);
	}
}

/**
 * The dashed page id inside a stored `notion_page`: a row URL (backfill keeps
 * `row.url`), a dashed id or a bare 32-hex id. The id is the last 32 hex
 * characters of the path's last hex run once dashes are gone — a slug such as
 * "Add-feed-<id>" runs straight into the id — and a query or fragment (which
 * can name a block inside the page) is ignored.
 */
export function notionPageId(ref: string | null | undefined): string | null {
	const path = ref?.split(/[?#]/, 1)[0]?.replaceAll("-", "").toLowerCase();
	const hex = path?.match(/[0-9a-f]{32}(?![0-9a-f])/g)?.at(-1);
	if (!hex) return null;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PropertyValue = string | null;

/**
 * The PATCH value for one property of the given Notion type; `null` clears it.
 * Returns null when the type cannot be written from a string — people,
 * relation and the rest — and for clearing a status, which Notion forbids.
 */
export function buildProperty(type: string, value: PropertyValue): Record<string, unknown> | null {
	switch (type) {
		case "rich_text":
		case "title":
			return { [type]: value === null ? [] : [{ text: { content: value } }] };
		case "select":
			return { select: value === null ? null : { name: value } };
		case "status":
			return value === null ? null : { status: { name: value } };
		case "multi_select":
			return { multi_select: value === null ? [] : [{ name: value }] };
		case "date":
			return { date: value === null ? null : { start: value } };
		default:
			return null;
	}
}

interface PageResponse {
	parent?: { type?: string; data_source_id?: string };
	properties?: Record<string, { type?: string }>;
}

export class NotionClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly baseUrl: string;
	/** Undashed and lower-cased, so either spelling of the configured id compares equal. */
	private readonly dataSourceId: string;

	constructor(
		private readonly apiKey: string,
		opts: { dataSourceId: string; fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string },
	) {
		this.dataSourceId = opts.dataSourceId.replaceAll("-", "").toLowerCase();
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.baseUrl = (opts.baseUrl ?? NOTION_API_URL).replace(/\/+$/, "");
	}

	/** Property name → Notion type of a task-graph row. */
	async getPage(pageId: string): Promise<Record<string, string>> {
		const page = await this.taskGraphPage(pageId);
		const types: Record<string, string> = {};
		for (const [name, property] of Object.entries(page.properties ?? {})) {
			if (property.type) types[name] = property.type;
		}
		return types;
	}

	/**
	 * One PATCH of already-shaped values. Refuses, before any request, a
	 * property outside NOTION_WRITABLE; then GETs the page and refuses one that
	 * is not a task-graph row.
	 */
	async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
		const refused = Object.keys(properties).filter((name) => !(NOTION_WRITABLE as readonly string[]).includes(name));
		if (refused.length) {
			throw new NotionError(
				`refusing to write ${refused.join(", ")}: substrate writes only ${NOTION_WRITABLE.join(", ")} (D-07)`,
			);
		}
		const id = (await this.taskGraphPage(pageId)).id;
		await this.request("PATCH", id, { properties });
	}
	/**
	 * One shaped write: a single GET (with the task-graph parent check) whose
	 * response supplies the property types, then one PATCH of the values
	 * shaped for those types. Returns a description per skipped property —
	 * unwritable types and missing properties are named together while the
	 * rest is still sent. At most one GET and one PATCH per call.
	 */
	async writeShaped(pageId: string, wants: Record<string, PropertyValue>): Promise<string[]> {
		const refused = Object.keys(wants).filter((name) => !(NOTION_WRITABLE as readonly string[]).includes(name));
		if (refused.length) {
			throw new NotionError(
				`refusing to write ${refused.join(", ")}: substrate writes only ${NOTION_WRITABLE.join(", ")} (D-07)`,
			);
		}
		const page = await this.taskGraphPage(pageId);
		const skipped: string[] = [];
		const properties: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(wants)) {
			const type = page.properties?.[name]?.type;
			const shaped = type ? buildProperty(type, value) : null;
			if (shaped) {
				properties[name] = shaped;
			} else {
				skipped.push(
					type
						? `"${name}" on page ${page.id} is a ${type} property, which substrate cannot write`
						: `page ${page.id} has no "${name}" property`,
				);
			}
		}
		if (Object.keys(properties).length > 0) await this.request("PATCH", page.id, { properties });
		return skipped;
	}


	/** GET a page and require its parent to be the configured data source. */
	private async taskGraphPage(pageId: string): Promise<PageResponse & { id: string }> {
		const id = notionPageId(pageId);
		if (!id) throw new NotionError(`not a Notion page id: ${pageId.slice(0, 100)}`);
		const page = (await this.request("GET", id)) as PageResponse;
		const parent = page.parent?.type === "data_source_id" ? page.parent.data_source_id : undefined;
		if (parent?.replaceAll("-", "").toLowerCase() !== this.dataSourceId) {
			const where = parent ? `data source ${parent}` : `a ${page.parent?.type ?? "missing"} parent`;
			throw new NotionError(`page ${id} is not a row of the Agent Task Graph (it is under ${where}); refusing it`);
		}
		return { ...page, id };
	}

	private async request(method: "GET" | "PATCH", id: string, body?: unknown): Promise<unknown> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Notion-Version": NOTION_VERSION,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/pages/${id}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new NotionError(`notion unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
		}

		const text = await response.text();
		if (!response.ok) throw new NotionError(`notion ${response.status}: ${text.slice(0, BODY_LIMIT)}`, response.status);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new NotionError(`notion returned non-JSON: ${text.slice(0, BODY_LIMIT)}`, response.status);
		}
	}
}
