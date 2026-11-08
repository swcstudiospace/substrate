// D-13: every permission_request is posted to a dedicated approval bot. Nothing here
// answers a request except an authorised single-use callback. The standing-permission
// option is never offered — after it the adapter would answer later calls with no tap.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { redact } from "../../mcp-server/src/redact.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TEXT_CAP = 3500;
const TRUNCATED = "…[truncated]";
const DEFAULT_STATE_PATH = "/var/lib/substrate/agentos/approvals.json";
const GET_UPDATES_TIMEOUT_MS = 35_000;
const CALL_TIMEOUT_MS = 10_000;

type ApprovalOption = { optionId: string; kind: string; name?: string };

type ApprovalPost = {
	graphId: string;
	nodeId: string;
	sessionId: string;
	requestId: string;
	tool: string;
	input: unknown;
	options: ApprovalOption[];
};

type ApprovalButton = { text: string; index: number };

type RenderedApproval = { text: string; buttons: ApprovalButton[] };

type ApprovalConfig = { chatId: string; userIds: number[] };

type ApprovalOutcome = "answered" | "not_pending";

type ApprovalDeps = {
	fetchImpl?: typeof fetch;
	log?: (line: string) => void;
	respond?: (graphId: string, sessionId: string, requestId: string, optionId: string) => Promise<ApprovalOutcome>;
	statePath?: string;
};

const IdField = z.union([z.string(), z.number()]);
const OptionSchema = z.object({
	optionId: z.string(),
	kind: z.string(),
	name: z.string().optional(),
});
const CallbackSchema = z.object({
	id: z.string().optional(),
	data: z.string().optional(),
	from: z.object({ id: IdField.optional(), first_name: z.string().optional() }).optional(),
	message: z
		.object({
			message_id: z.number().optional(),
			text: z.string().optional(),
			chat: z.object({ id: IdField.optional() }).optional(),
		})
		.optional(),
});
const UpdateSchema = z.object({
	update_id: z.number().optional(),
	callback_query: CallbackSchema.optional(),
});
const ApiReplySchema = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error_code: z.number().optional(),
	description: z.string().optional(),
});
const MessageResultSchema = z.object({ message_id: z.number() });
const MeSchema = z.object({ username: z.string() });
const KeyRecordSchema = z.object({
	graphId: z.string(),
	nodeId: z.string(),
	sessionId: z.string(),
	requestId: z.string(),
	options: z.array(OptionSchema),
	offered: z.array(z.number()),
	messageId: z.number(),
	text: z.string(),
	answered: z.boolean(),
});
type KeyRecord = z.infer<typeof KeyRecordSchema>;
const StateSchema = z.object({
	offset: z.number(),
	keys: z.record(z.string(), KeyRecordSchema),
});

export function encodeCallback(key: string, index: number): string {
	return `ap:${key}:${index}`;
}

export function decodeCallback(data: string): { key: string; index: number } | null {
	const match = /^ap:([A-Z2-7]{13}):([0-9])$/.exec(data);
	if (!match) return null;
	return { key: match[1] ?? "", index: Number(match[2]) };
}

/** 8 random bytes → 13 unpadded RFC 4648 base32 characters (64 bits, no padding chars). */
export function newApprovalKey(): string {
	const bytes = randomBytes(8);
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32[(value >> bits) & 31];
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function isAuthorised(update: unknown, cfg: ApprovalConfig): boolean {
	const parsed = UpdateSchema.safeParse(update);
	if (!parsed.success) return false;
	const fromId = parsed.data.callback_query?.from?.id;
	if (typeof fromId !== "number" && typeof fromId !== "string") return false;
	const id = Number(fromId);
	if (!Number.isInteger(id) || !cfg.userIds.includes(id)) return false;
	const chatId = parsed.data.callback_query?.message?.chat?.id;
	if (chatId === undefined) return false;
	return String(chatId) === String(cfg.chatId);
}

export function renderApprovalMessage(input: {
	graphId: string;
	nodeId: string;
	tool: string;
	input: unknown;
	options: ApprovalOption[];
}): RenderedApproval {
	const tool = redact(input.tool);
	const body = redact(JSON.stringify(input.input ?? null));
	let text = `Approval ${input.graphId}/${input.nodeId}\n${tool}\n${body}`;
	if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP - TRUNCATED.length) + TRUNCATED;
	let approve: ApprovalButton | null = null;
	let deny: ApprovalButton | null = null;
	input.options.forEach((option, index) => {
		if (option.kind === "allow_once" && !approve) approve = { text: "Approve", index };
		else if (option.kind === "reject_once" && !deny) deny = { text: "Deny", index };
	});
	const buttons: ApprovalButton[] = [];
	if (approve) buttons.push(approve);
	if (deny) buttons.push(deny);
	return { text, buttons };
}

export class TelegramError extends Error {
	code: number | null;
	constructor(message: string, code: number | null = null) {
		super(message);
		this.name = "TelegramError";
		this.code = code;
	}
}

function scrub(text: string, token: string): string {
	const withoutToken = token ? text.split(token).join("") : text;
	return withoutToken.replace(/https?:\/\/\S+/g, "").slice(0, 200);
}

export class TelegramClient {
	token: string;
	fetchImpl: typeof fetch;
	constructor(token: string, opts?: { fetchImpl?: typeof fetch | undefined }) {
		this.token = token;
		this.fetchImpl = opts?.fetchImpl ?? fetch;
	}

	async call(method: string, params: Record<string, unknown>, timeoutMs = method === "getUpdates" ? GET_UPDATES_TIMEOUT_MS : CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const url = `https://api.telegram.org/bot${this.token}/${method}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params),
				signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			if (cause instanceof TelegramError) throw cause;
			const name = cause instanceof Error ? cause.name : "Error";
			throw new TelegramError(`telegram ${method}: request failed (${name})`, null);
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			throw new TelegramError(`telegram ${method}: request failed (SyntaxError)`, null);
		}
		const body = ApiReplySchema.safeParse(parsed);
		if (!body.success || !body.data.ok) {
			const code = body.success ? (body.data.error_code ?? 0) : 0;
			const description = body.success ? (body.data.description ?? "") : "";
			throw new TelegramError(`telegram ${method}: ${code} ${scrub(description, this.token)}`.trim(), code);
		}
		return body.data.result;
	}
}

export class ApprovalBroker {
	enabled: boolean;
	client: TelegramClient | null;
	chatId: string;
	userIds: number[];
	statePath: string;
	log: (line: string) => void;
	respond: (graphId: string, sessionId: string, requestId: string, optionId: string) => Promise<ApprovalOutcome>;
	offset: number;
	keys: Record<string, KeyRecord>;
	inflight: Record<string, true>;
	stopped: boolean;
	abort: AbortController | null;

	constructor(opts: {
		enabled: boolean;
		client?: TelegramClient | null;
		chatId?: string;
		userIds?: number[];
		statePath?: string | undefined;
		log?: ((line: string) => void) | undefined;
		respond?: ApprovalDeps["respond"];
	}) {
		this.enabled = opts.enabled;
		this.client = opts.client ?? null;
		this.chatId = opts.chatId ?? "";
		this.userIds = opts.userIds ?? [];
		this.statePath = opts.statePath ?? DEFAULT_STATE_PATH;
		this.log = opts.log ?? (() => undefined);
		this.respond = opts.respond ?? (async () => "not_pending");
		this.offset = 0;
		this.keys = {};
		this.inflight = {};
		this.stopped = false;
		this.abort = null;
		if (this.enabled) this.load();
	}

	stop(): void {
		this.stopped = true;
		this.abort?.abort();
	}

	async whoami(): Promise<string> {
		if (!this.client) throw new TelegramError("telegram getMe: request failed (Error)", null);
		const me = MeSchema.safeParse(await this.client.call("getMe", {}));
		const username = me.success ? me.data.username.trim() : "";
		if (!username) throw new TelegramError("telegram getMe: missing username", null);
		return username;
	}

	async post(input: ApprovalPost): Promise<void> {
		if (!this.enabled || !this.client) {
			this.log("[substrate-host] approval not posted (telegram approvals off)");
			return;
		}
		const key = newApprovalKey();
		const rendered = renderApprovalMessage(input);
		const sent = MessageResultSchema.safeParse(
			await this.client.call("sendMessage", {
				chat_id: this.chatId,
				text: rendered.text,
				reply_markup: {
					inline_keyboard: [rendered.buttons.map((button) => ({ text: button.text, callback_data: encodeCallback(key, button.index) }))],
				},
			}),
		);
		this.keys[key] = {
			graphId: input.graphId,
			nodeId: input.nodeId,
			sessionId: input.sessionId,
			requestId: input.requestId,
			options: input.options,
			offered: rendered.buttons.map((button) => button.index),
			messageId: sent.success ? sent.data.message_id : 0,
			text: rendered.text,
			answered: false,
		};
		this.persist();
	}

	async handleUpdate(update: unknown): Promise<void> {
		if (!this.enabled || !this.client) return;
		const parsed = UpdateSchema.safeParse(update);
		const query = parsed.success ? parsed.data.callback_query : undefined;
		if (!query?.id) return;
		if (!isAuthorised(update, { chatId: this.chatId, userIds: this.userIds })) {
			await this.answer(query.id, "not allowed");
			return;
		}
		const decoded = decodeCallback(query.data ?? "");
		const entry = decoded ? this.keys[decoded.key] : undefined;
		if (!decoded || !entry || entry.answered || this.inflight[decoded.key]) {
			await this.answer(query.id, "expired");
			return;
		}
		const option = entry.options[decoded.index];
		if (!entry.offered.includes(decoded.index) || !option || (option.kind !== "allow_once" && option.kind !== "reject_once")) {
			await this.answer(query.id, "not offered");
			return;
		}
		this.inflight[decoded.key] = true;
		this.log(`[substrate-host] approval ${decoded.key} callback authorised for ${entry.graphId}/${entry.nodeId}`);
		let outcome: ApprovalOutcome = "not_pending";
		try {
			outcome = await this.respond(entry.graphId, entry.sessionId, entry.requestId, option.optionId);
		} catch {
			outcome = "not_pending";
		}
		entry.answered = true;
		delete this.inflight[decoded.key];
		this.persist();
		if (outcome !== "answered") {
			await this.answer(query.id, "expired");
			return;
		}
		this.log(`[substrate-host] approval ${decoded.key} answered ${option.optionId} for ${entry.graphId}/${entry.nodeId}`);
		const who = query.from?.first_name?.trim() || "approver";
		const verb = option.kind === "allow_once" ? "Approved" : "Denied";
		await this.answer(query.id, verb);
		await this.client.call("editMessageReplyMarkup", {
			chat_id: this.chatId,
			message_id: entry.messageId,
			reply_markup: { inline_keyboard: [] },
		});
		const edited = `${entry.text}\n\n${verb} by ${who}`;
		await this.client.call("editMessageText", {
			chat_id: this.chatId,
			message_id: entry.messageId,
			text: edited.length > TEXT_CAP ? edited.slice(0, TEXT_CAP - TRUNCATED.length) + TRUNCATED : edited,
		});
	}

	async pollOnce(): Promise<void> {
		if (!this.enabled || !this.client || this.stopped) return;
		const controller = new AbortController();
		this.abort = controller;
		let updates: unknown;
		try {
			updates = await this.client.call("getUpdates", {
				offset: this.offset,
				timeout: 30,
				allowed_updates: ["callback_query"],
			}, GET_UPDATES_TIMEOUT_MS, controller.signal);
		} finally {
			if (this.abort === controller) this.abort = null;
		}
		if (!Array.isArray(updates)) return;
		for (const update of updates) {
			await this.handleUpdate(update);
			const parsed = UpdateSchema.safeParse(update);
			if (parsed.success && parsed.data.update_id !== undefined) {
				this.offset = parsed.data.update_id + 1;
				this.persist();
			}
		}
	}

	async answer(callbackId: string, text: string): Promise<void> {
		if (!this.client) return;
		await this.client.call("answerCallbackQuery", { callback_query_id: callbackId, text });
	}

	load(): void {
		if (!existsSync(this.statePath)) return;
		try {
			const parsed = StateSchema.safeParse(JSON.parse(readFileSync(this.statePath, "utf8")));
			if (!parsed.success) return;
			this.offset = parsed.data.offset;
			this.keys = parsed.data.keys;
		} catch {
			this.offset = 0;
			this.keys = {};
		}
	}

	persist(): void {
		mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const tmp = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ offset: this.offset, keys: this.keys })}\n`, { mode: 0o600 });
		try {
			renameSync(tmp, this.statePath);
		} catch (cause) {
			rmSync(tmp, { force: true });
			throw cause;
		}
		chmodSync(this.statePath, 0o600);
	}
}

export function createApprovals(env: Record<string, string | undefined>, deps: ApprovalDeps = {}): ApprovalBroker {
	const token = env.SUBSTRATE_APPROVAL_BOT_TOKEN?.trim() ?? "";
	const chatId = env.SUBSTRATE_APPROVAL_CHAT_ID?.trim() ?? "";
	const userIds = (env.SUBSTRATE_APPROVAL_USER_IDS ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => /^\d+$/.test(part))
		.map((part) => Number(part));
	if (!token || !chatId || userIds.length === 0) {
		return new ApprovalBroker({ enabled: false, log: deps.log, respond: deps.respond, statePath: deps.statePath });
	}
	return new ApprovalBroker({
		enabled: true,
		client: new TelegramClient(token, { fetchImpl: deps.fetchImpl }),
		chatId,
		userIds,
		statePath: deps.statePath,
		log: deps.log,
		respond: deps.respond,
	});
}

