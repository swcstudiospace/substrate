import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	ApprovalBroker,
	createApprovals,
	decodeCallback,
	encodeCallback,
	isAuthorised,
	newApprovalKey,
	renderApprovalMessage,
	TelegramClient,
	TelegramError,
} from "./telegram.ts";

const KEY = "ABCDEFGHIJKLM";
const USER = 900001;
const OTHER_USER = 900009;
const CHAT = 900002;
const OTHER_CHAT = 900008;
const SECRET_BODY = "UNLOGGED-BODY";
const OPTIONS = [
	{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
	{ optionId: "allow_always", kind: "allow_always", name: "Always allow" },
	{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
];

type FetchCall = { method: string; params: Record<string, unknown>; url: string };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scriptedFetch(handler: (call: FetchCall) => unknown): { fetchImpl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input, init) => {
		const url = String(input);
		const method = url.split("/").pop() ?? "";
		const params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const call = { method, params, url };
		calls.push(call);
		const result = await handler(call);
		if (result instanceof Response) return result;
		return jsonResponse({ ok: true, result });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function update(partial: {
	id?: string;
	from?: { id: number; first_name: string } | null;
	chatId?: number;
	data?: string;
	messageId?: number;
	text?: string;
}): { update_id: number; callback_query: Record<string, unknown> } {
	const callback: Record<string, unknown> = {
		id: partial.id ?? "cb-1",
		message: {
			message_id: partial.messageId ?? 42,
			chat: { id: partial.chatId ?? CHAT },
			text: partial.text ?? SECRET_BODY,
		},
		data: partial.data ?? `ap:${KEY}:2`,
	};
	if (partial.from !== null) callback.from = partial.from ?? { id: USER, first_name: "Ada" };
	return { update_id: 7, callback_query: callback };
}

function authConfig(): { chatId: string; userIds: number[] } {
	return { chatId: String(CHAT), userIds: [USER, 900003] };
}

const ON_ENV = {
	SUBSTRATE_APPROVAL_BOT_TOKEN: "123456789:AAHfakeTokenValueForTestOnlyXXXX",
	SUBSTRATE_APPROVAL_CHAT_ID: String(CHAT),
	SUBSTRATE_APPROVAL_USER_IDS: `${USER},900003`,
};

describe("telegram approvals", () => {
	test("encodeCallback returns ap:key:index of at most 64 bytes and decodeCallback accepts only the canonical form", () => {
		const encoded = encodeCallback(KEY, 2);
		expect(encoded).toBe(`ap:${KEY}:2`);
		expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(64);
		expect(decodeCallback(encoded)).toEqual({ key: KEY, index: 2 });
		expect(decodeCallback(`ap:${KEY.toLowerCase()}:2`)).toBeNull();
		expect(decodeCallback(`ap:${KEY}:2:extra`)).toBeNull();
		expect(decodeCallback(`ap:${KEY}:`)).toBeNull();
		expect(decodeCallback("nope")).toBeNull();
		expect(decodeCallback(`xx:${KEY}:2`)).toBeNull();
	});

	test("newApprovalKey returns 13 base32 characters and 1000 calls are distinct", () => {
		const keys = new Set<string>();
		for (let i = 0; i < 1000; i++) keys.add(newApprovalKey());
		expect(keys.size).toBe(1000);
		for (const key of keys) expect(key).toMatch(/^[A-Z2-7]{13}$/);
	});

	test("isAuthorised accepts only the configured user in the configured chat", () => {
		const cfg = authConfig();
		expect(isAuthorised(update({}), cfg)).toBe(true);
		expect(isAuthorised(update({ chatId: OTHER_CHAT }), cfg)).toBe(false);
		expect(isAuthorised(update({ from: { id: OTHER_USER, first_name: "Eve" } }), cfg)).toBe(false);
		expect(isAuthorised(update({ from: null }), cfg)).toBe(false);
	});

	test("renderApprovalMessage redacts secrets, names the graph and node, stays under 4000 characters, and offers only Approve and Deny", () => {
		const lin = `lin_api_${"a".repeat(24)}`;
		const ghp = `ghp_${"b".repeat(24)}`;
		const rendered = renderApprovalMessage({
			graphId: "g-1",
			nodeId: "n-1",
			tool: `run ${lin}`,
			input: { cmd: ghp, blob: "x".repeat(50_000) },
			options: OPTIONS,
		});
		expect(rendered.text).toContain("g-1");
		expect(rendered.text).toContain("n-1");
		expect(rendered.text).not.toContain("lin_api_");
		expect(rendered.text).not.toContain("ghp_");
		expect(rendered.text).toContain("[REDACTED]");
		expect(rendered.text.length).toBeLessThan(4000);
		expect(rendered.text.length).toBeLessThanOrEqual(3500);
		expect(rendered.text).toContain("…[truncated]");
		expect(rendered.buttons).toEqual([
			{ text: "Approve", index: 0 },
			{ text: "Deny", index: 2 },
		]);
		expect(rendered.buttons.some((b) => b.index === 1)).toBe(false);
	});

	test("ApprovalBroker.post sends one sendMessage and persists the key map and offset to a 0600 file that reloads", async () => {
		const dir = mkdtempSync(join(tmpdir(), "approvals-"));
		const statePath = join(dir, "approvals.json");
		const logs: string[] = [];
		const { fetchImpl, calls } = scriptedFetch((call) => {
			if (call.method === "sendMessage") return { message_id: 42 };
			if (call.method === "getUpdates") return [{ update_id: 15 }];
			return true;
		});
		const broker = createApprovals(ON_ENV, { fetchImpl, log: (line) => logs.push(line), respond: async () => "answered", statePath });
		await broker.post({
			graphId: "g-1",
			nodeId: "n-1",
			sessionId: "n-1",
			requestId: "req-1",
			tool: "Bash",
			input: { cmd: "ls" },
			options: OPTIONS,
		});
		const sent = calls.filter((c) => c.method === "sendMessage");
		expect(sent).toHaveLength(1);
		expect(String(sent[0]?.params.chat_id)).toBe(String(CHAT));
		const keyboard = sent[0]?.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
		expect(keyboard.inline_keyboard[0]?.map((b) => b.text)).toEqual(["Approve", "Deny"]);
		const row = keyboard.inline_keyboard[0] ?? [];
		const approve = decodeCallback(row[0]?.callback_data ?? "");
		const deny = decodeCallback(row[1]?.callback_data ?? "");
		expect(approve?.index).toBe(0);
		expect(deny?.index).toBe(2);
		expect(approve?.key).toBe(deny?.key);
		const key = approve?.key ?? "";
		expect(key).toMatch(/^[A-Z2-7]{13}$/);
		await broker.pollOnce();
		const raw = JSON.parse(readFileSync(statePath, "utf8")) as { offset: number; keys: Record<string, { graphId: string; sessionId: string; requestId: string }> };
		expect(raw.offset).toBe(16);
		expect(raw.keys[key]?.graphId).toBe("g-1");
		expect(raw.keys[key]?.sessionId).toBe("n-1");
		expect(raw.keys[key]?.requestId).toBe("req-1");
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
		const reloaded = createApprovals(ON_ENV, { fetchImpl, log: (line) => logs.push(line), respond: async () => "answered", statePath });
		await reloaded.pollOnce();
		const offsets = calls.filter((c) => c.method === "getUpdates").map((c) => c.params.offset);
		expect(offsets).toContain(16);
	});

	test("an authorised reject_once callback logs authorised before respond, then answered, and a second tap is expired", async () => {
		const dir = mkdtempSync(join(tmpdir(), "approvals-"));
		const statePath = join(dir, "approvals.json");
		const events: Array<{ kind: "log" | "respond"; line?: string; optionId?: string }> = [];
		const { fetchImpl, calls } = scriptedFetch((call) => (call.method === "sendMessage" ? { message_id: 42 } : true));
		const broker = createApprovals(ON_ENV, {
			fetchImpl,
			statePath,
			log: (line) => events.push({ kind: "log", line }),
			respond: async (_g, _s, _r, optionId) => {
				events.push({ kind: "respond", optionId });
				return "answered";
			},
		});
		await broker.post({
			graphId: "g-1",
			nodeId: "n-1",
			sessionId: "n-1",
			requestId: "req-1",
			tool: "Bash",
			input: { cmd: "ls" },
			options: OPTIONS,
		});
		const sent = calls.find((c) => c.method === "sendMessage");
		const keyboard = sent?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
		const data = keyboard.inline_keyboard[0]?.find((b) => decodeCallback(b.callback_data)?.index === 2)?.callback_data ?? "";
		const key = decodeCallback(data)?.key ?? "";
		calls.length = 0;
		await broker.handleUpdate(update({ data, id: "cb-ok" }));
		const authorised = events.findIndex((e) => e.kind === "log" && e.line === `[substrate-host] approval ${key} callback authorised for g-1/n-1`);
		const responded = events.findIndex((e) => e.kind === "respond" && e.optionId === "reject_once");
		const answered = events.findIndex((e) => e.kind === "log" && e.line === `[substrate-host] approval ${key} answered reject_once for g-1/n-1`);
		expect(authorised).toBeGreaterThanOrEqual(0);
		expect(responded).toBeGreaterThan(authorised);
		expect(answered).toBeGreaterThan(responded);
		expect(events.filter((e) => e.kind === "respond")).toHaveLength(1);
		for (const event of events) {
			if (event.kind !== "log") continue;
			expect(event.line).not.toContain(String(USER));
			expect(event.line).not.toContain(String(CHAT));
			expect(event.line).not.toContain(SECRET_BODY);
		}
		const methods = calls.map((c) => c.method);
		expect(methods).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "editMessageText"]);
		expect(calls[0]?.params.text === undefined || calls[0]?.params.callback_query_id).toBeTruthy();
		const edited = calls.find((c) => c.method === "editMessageText");
		expect(String(edited?.params.text)).toContain("Denied");
		expect(String(edited?.params.text)).toContain("Ada");
		const cleared = calls.find((c) => c.method === "editMessageReplyMarkup");
		expect(cleared?.params.reply_markup).toEqual({ inline_keyboard: [] });
		calls.length = 0;
		await broker.handleUpdate(update({ data, id: "cb-again" }));
		expect(events.filter((e) => e.kind === "respond")).toHaveLength(1);
		expect(calls.find((c) => c.method === "answerCallbackQuery")?.params.text).toBe("expired");
	});

	test("unauthorised callbacks are not allowed, unknown keys are expired, and not_pending marks the key answered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "approvals-"));
		const statePath = join(dir, "approvals.json");
		let pending: "answered" | "not_pending" = "answered";
		const respondCalls: string[] = [];
		const { fetchImpl, calls } = scriptedFetch((call) => (call.method === "sendMessage" ? { message_id: 42 } : true));
		const broker = createApprovals(ON_ENV, {
			fetchImpl,
			statePath,
			log: () => undefined,
			respond: async (_g, _s, _r, optionId) => {
				respondCalls.push(optionId);
				return pending;
			},
		});
		await broker.handleUpdate(update({ from: { id: OTHER_USER, first_name: "Eve" }, data: `ap:${KEY}:2` }));
		expect(calls.at(-1)?.params.text).toBe("not allowed");
		expect(respondCalls).toEqual([]);
		calls.length = 0;
		await broker.handleUpdate(update({ chatId: OTHER_CHAT, data: `ap:${KEY}:2` }));
		expect(calls.at(-1)?.params.text).toBe("not allowed");
		expect(respondCalls).toEqual([]);
		calls.length = 0;
		await broker.handleUpdate(update({ data: `ap:${KEY}:0`, id: "cb-unknown" }));
		expect(calls.at(-1)?.params.text).toBe("expired");
		expect(respondCalls).toEqual([]);
		await broker.post({
			graphId: "g-1",
			nodeId: "n-1",
			sessionId: "n-1",
			requestId: "req-np",
			tool: "Bash",
			input: {},
			options: OPTIONS,
		});
		const sent = calls.find((c) => c.method === "sendMessage");
		const keyboard = sent?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
		const data = keyboard.inline_keyboard[0]?.find((b) => decodeCallback(b.callback_data)?.index === 2)?.callback_data ?? "";
		pending = "not_pending";
		calls.length = 0;
		await broker.handleUpdate(update({ data, id: "cb-np" }));
		expect(respondCalls).toEqual(["reject_once"]);
		expect(calls.find((c) => c.method === "answerCallbackQuery")?.params.text).toBe("expired");
		calls.length = 0;
		await broker.handleUpdate(update({ data, id: "cb-np-2" }));
		expect(respondCalls).toEqual(["reject_once"]);
		expect(calls.find((c) => c.method === "answerCallbackQuery")?.params.text).toBe("expired");
	});

	test("an authorised callback for an option that was not offered is refused and the key stays pending", async () => {
		const dir = mkdtempSync(join(tmpdir(), "approvals-"));
		const statePath = join(dir, "approvals.json");
		const logs: string[] = [];
		const respondCalls: string[] = [];
		const { fetchImpl, calls } = scriptedFetch((call) => (call.method === "sendMessage" ? { message_id: 42 } : true));
		const broker = createApprovals(ON_ENV, {
			fetchImpl,
			statePath,
			log: (line) => logs.push(line),
			respond: async (_g, _s, _r, optionId) => {
				respondCalls.push(optionId);
				return "answered";
			},
		});
		await broker.post({
			graphId: "g-1",
			nodeId: "n-1",
			sessionId: "n-1",
			requestId: "req-1",
			tool: "Bash",
			input: {},
			options: OPTIONS,
		});
		const sent = calls.find((c) => c.method === "sendMessage");
		const keyboard = sent?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
		const deny = keyboard.inline_keyboard[0]?.find((b) => decodeCallback(b.callback_data)?.index === 2)?.callback_data ?? "";
		const key = decodeCallback(deny)?.key ?? "";
		calls.length = 0;
		await broker.handleUpdate(update({ data: encodeCallback(key, 1), id: "cb-always" }));
		expect(calls.find((c) => c.method === "answerCallbackQuery")?.params.text).toBe("not offered");
		expect(respondCalls).toEqual([]);
		expect(logs.some((line) => line.includes(" answered "))).toBe(false);
		calls.length = 0;
		await broker.handleUpdate(update({ data: encodeCallback(key, 9), id: "cb-past" }));
		expect(calls.find((c) => c.method === "answerCallbackQuery")?.params.text).toBe("not offered");
		expect(respondCalls).toEqual([]);
		await broker.handleUpdate(update({ data: deny, id: "cb-still" }));
		expect(respondCalls).toEqual(["reject_once"]);
	});

	test("TelegramError never contains the bot token or the Bot API URL", async () => {
		const token = "123456789:AAHfakeTokenValueForTestOnlyXXXX";
		const { fetchImpl } = scriptedFetch(() => {
			throw new Error(`network down https://api.telegram.org/bot${token}/getMe`);
		});
		const client = new TelegramClient(token, { fetchImpl });
		let caught: unknown;
		try {
			await client.call("getMe", {});
		} catch (cause) {
			caught = cause;
		}
		expect(caught).toBeInstanceOf(TelegramError);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).not.toContain(token);
		expect(message).not.toContain("api.telegram.org");
		expect(message).not.toContain("/bot");
	});

	test("createApprovals without all three SUBSTRATE_APPROVAL values returns an off broker that never calls respond", async () => {
		const respondCalls: string[] = [];
		const logs: string[] = [];
		const { fetchImpl, calls } = scriptedFetch(() => true);
		const respond = async () => {
			respondCalls.push("called");
			return "answered" as const;
		};
		for (const env of [{}, { SUBSTRATE_APPROVAL_BOT_TOKEN: "123456789:AAHfakeTokenValueForTestOnlyXXXX", SUBSTRATE_APPROVAL_CHAT_ID: "1" }, { SUBSTRATE_APPROVAL_BOT_TOKEN: "   ", SUBSTRATE_APPROVAL_CHAT_ID: "1", SUBSTRATE_APPROVAL_USER_IDS: "1" }]) {
			const broker = createApprovals(env, { fetchImpl, log: (line) => logs.push(line), respond });
			expect(broker).toBeInstanceOf(ApprovalBroker);
			await broker.post({
				graphId: "g-1",
				nodeId: "n-1",
				sessionId: "n-1",
				requestId: "req-1",
				tool: "Bash",
				input: {},
				options: OPTIONS,
			});
			await broker.handleUpdate(update({}));
			await broker.pollOnce();
		}
		expect(respondCalls).toEqual([]);
		expect(calls).toEqual([]);
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.every((line) => line.includes("telegram approvals off"))).toBe(true);
	});
});
