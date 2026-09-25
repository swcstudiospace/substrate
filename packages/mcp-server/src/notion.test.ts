import { describe, expect, test } from "bun:test";
import { buildProperty, NOTION_VERSION, NOTION_WRITABLE, NotionClient, NotionError, notionPageId } from "./notion.ts";

const KEY = "ntn_notion_test_key_0123456789";
const DS = "be3418f0-d2d8-411b-8677-fa8a95ee63be";
const PAGE = "3e4bc1a0-c7ae-81ba-afff-d1ebd773123d";

interface Recorded {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

interface FakePage {
	parent?: Record<string, unknown>;
	properties?: Record<string, { type: string }>;
	status?: number;
	text?: string;
}

/** A Notion stand-in that records every request and answers GET/PATCH /pages/{id} from `pages`. */
function fakeNotion(pages: Record<string, FakePage>) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		requests.push({
			method: init.method ?? "GET",
			url,
			headers: init.headers as Record<string, string>,
			body: init.body ? JSON.parse(String(init.body)) : undefined,
		});
		const id = url.split("/pages/")[1] ?? "";
		const page = pages[id];
		if (!page) return new Response(JSON.stringify({ object: "error", status: 404, code: "object_not_found" }), { status: 404 });
		if (page.status) return new Response(page.text ?? "", { status: page.status });
		return new Response(
			JSON.stringify({
				object: "page",
				id,
				parent: page.parent ?? { type: "data_source_id", data_source_id: DS, database_id: "843bc6ab-56b0-4b27-ae10-e258711edcb0" },
				properties: page.properties ?? {},
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return { requests, client: new NotionClient(KEY, { dataSourceId: DS, fetchImpl }) };
}

const ISSUE_ROW = {
	properties: {
		Item: { type: "title" },
		Agent: { type: "rich_text" },
		Status: { type: "status" },
		"Linear State": { type: "select" },
		Completed: { type: "date" },
	},
};

describe("notionPageId", () => {
	test("a row URL and the dashed id resolve to the same dashed page id", () => {
		expect(notionPageId("https://www.notion.so/Item-3e4bc1a0c7ae81baafffd1ebd773123d")).toBe(PAGE);
		expect(notionPageId("3e4bc1a0-c7ae-81ba-afff-d1ebd773123d")).toBe(PAGE);
		expect(notionPageId("3E4BC1A0C7AE81BAAFFFD1EBD773123D")).toBe(PAGE);
	});

	test("hex-looking slug words and a query or fragment do not shift the id", () => {
		// "Add-feed" is all hex once the dashes go; the id is the last 32 of the run.
		expect(notionPageId("https://www.notion.so/Add-feed-3e4bc1a0c7ae81baafffd1ebd773123d?pvs=4")).toBe(PAGE);
		// A fragment names a block inside the page, not the page itself.
		expect(notionPageId(`https://app.notion.com/3e4bc1a0c7ae81baafffd1ebd773123d#${"b".repeat(32)}`)).toBe(PAGE);
	});

	test("anything without a 32-hex id is null", () => {
		expect(notionPageId("nope")).toBeNull();
		expect(notionPageId("https://www.notion.so/Item-3e4bc1a0c7ae81ba")).toBeNull();
		expect(notionPageId(null)).toBeNull();
		expect(notionPageId(undefined)).toBeNull();
		expect(notionPageId("")).toBeNull();
	});
});

describe("buildProperty", () => {
	test("shapes a value for each writable type", () => {
		expect(buildProperty("rich_text", "hermes")).toEqual({ rich_text: [{ text: { content: "hermes" } }] });
		expect(buildProperty("title", "[n1] x")).toEqual({ title: [{ text: { content: "[n1] x" } }] });
		expect(buildProperty("select", "Todo")).toEqual({ select: { name: "Todo" } });
		expect(buildProperty("status", "Done")).toEqual({ status: { name: "Done" } });
		expect(buildProperty("multi_select", "hermes")).toEqual({ multi_select: [{ name: "hermes" }] });
		expect(buildProperty("date", "2026-09-24")).toEqual({ date: { start: "2026-09-24" } });
	});

	test("clears with the empty shape of each type; status cannot be cleared", () => {
		expect(buildProperty("rich_text", null)).toEqual({ rich_text: [] });
		expect(buildProperty("title", null)).toEqual({ title: [] });
		expect(buildProperty("select", null)).toEqual({ select: null });
		expect(buildProperty("multi_select", null)).toEqual({ multi_select: [] });
		expect(buildProperty("date", null)).toEqual({ date: null });
		expect(buildProperty("status", null)).toBeNull();
	});

	test("people, relation and other types are unsupported", () => {
		expect(buildProperty("people", "hermes")).toBeNull();
		expect(buildProperty("relation", "hermes")).toBeNull();
		expect(buildProperty("url", "https://example.com")).toBeNull();
	});
});

describe("NotionClient.updatePage — D-07 allowlist", () => {
	test("NOTION_WRITABLE is exactly Agent, Status, Linear State, Completed", () => {
		expect([...NOTION_WRITABLE]).toEqual(["Agent", "Status", "Linear State", "Completed"]);
	});

	for (const name of ["PR URL", "PR #", "PR State", "Repo", "Branch"]) {
		test(`refuses ${name} before any request`, async () => {
			const { requests, client } = fakeNotion({ [PAGE]: ISSUE_ROW });

			const attempt = client.updatePage(PAGE, { Agent: buildProperty("rich_text", "hermes"), [name]: { url: "x" } });

			await expect(attempt).rejects.toBeInstanceOf(NotionError);
			await expect(attempt).rejects.toThrow(name);
			expect(requests).toEqual([]);
		});
	}
});

describe("NotionClient.getPage", () => {
	test("GETs the page with the bearer key and API version and returns name → type", async () => {
		const { requests, client } = fakeNotion({ [PAGE]: ISSUE_ROW });

		const types = await client.getPage(PAGE);

		expect(types).toEqual({
			Item: "title",
			Agent: "rich_text",
			Status: "status",
			"Linear State": "select",
			Completed: "date",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.method).toBe("GET");
		expect(requests[0]!.url).toBe(`https://api.notion.com/v1/pages/${PAGE}`);
		expect(requests[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(requests[0]!.headers["Notion-Version"]).toBe(NOTION_VERSION);
		expect(NOTION_VERSION).toBe("2025-09-03");
	});

	test("a 404 is a NotionError with status 404 and neither the key nor any header in its message", async () => {
		const { client } = fakeNotion({});

		const error = await client.getPage(PAGE).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(NotionError);
		expect((error as NotionError).status).toBe(404);
		const message = (error as NotionError).message;
		expect(message).toContain("404");
		expect(message).not.toContain(KEY);
		expect(message).not.toContain("Bearer");
		expect(message).not.toContain("Notion-Version");
	});

	test("an error body is cut to 200 characters", async () => {
		const { client } = fakeNotion({ [PAGE]: { status: 502, text: "x".repeat(500) } });

		const error = (await client.getPage(PAGE).catch((e: unknown) => e)) as NotionError;

		expect(error.status).toBe(502);
		expect(error.message.match(/x/g)?.length).toBe(200);
	});

	test("a string that holds no page id is refused without a request", async () => {
		const { requests, client } = fakeNotion({});

		await expect(client.getPage("../users/me")).rejects.toBeInstanceOf(NotionError);
		expect(requests).toEqual([]);
	});
});

describe("NotionClient — Agent Task Graph parent check (the key is a workspace-wide PAT)", () => {
	const foreign: Record<string, FakePage> = {
		// Same property names, but a row of some other database.
		"11111111-2222-3333-4444-555555555555": {
			...ISSUE_ROW,
			parent: { type: "data_source_id", data_source_id: "99999999-8888-7777-6666-555555555555" },
		},
		// A plain page nested under another page.
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": { ...ISSUE_ROW, parent: { type: "page_id", page_id: PAGE } },
	};

	for (const id of Object.keys(foreign)) {
		test(`getPage refuses a page outside the task graph (${foreign[id]!.parent!.type})`, async () => {
			const { client } = fakeNotion(foreign);

			await expect(client.getPage(id)).rejects.toThrow("not a row of the Agent Task Graph");
		});

		test(`updatePage GETs the page first and never PATCHes one outside the task graph (${foreign[id]!.parent!.type})`, async () => {
			const { requests, client } = fakeNotion(foreign);

			const attempt = client.updatePage(id, { Agent: buildProperty("rich_text", "hermes") });

			await expect(attempt).rejects.toBeInstanceOf(NotionError);
			expect(requests.map((r) => r.method)).toEqual(["GET"]);
		});
	}

	test("updatePage on a task-graph row: GET, then one PATCH carrying exactly the properties", async () => {
		const { requests, client } = fakeNotion({ [PAGE]: ISSUE_ROW });
		const properties = { Agent: buildProperty("rich_text", "hermes"), "Linear State": buildProperty("select", "In Progress") };

		await client.updatePage(PAGE, properties);

		expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
			`GET https://api.notion.com/v1/pages/${PAGE}`,
			`PATCH https://api.notion.com/v1/pages/${PAGE}`,
		]);
		expect(requests[1]!.body).toEqual({ properties });
		expect(requests[1]!.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(requests[1]!.headers["Notion-Version"]).toBe(NOTION_VERSION);
	});

	test("the configured data source may be written without dashes", async () => {
		const reply = { parent: { type: "data_source_id", data_source_id: DS }, properties: { Agent: { type: "rich_text" } } };
		const fetchImpl = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
		const client = new NotionClient(KEY, { dataSourceId: DS.replaceAll("-", "").toUpperCase(), fetchImpl });

		expect(await client.getPage(PAGE)).toEqual({ Agent: "rich_text" });
	});
});
