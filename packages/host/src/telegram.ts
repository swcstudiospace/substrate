// RED stub: exports exist so telegram.test.ts fails on assertions, not on a missing module.
// The implementation replaces this file in the GREEN commit.

export function encodeCallback(_key: string, _index: number): string {
	return "";
}

export function decodeCallback(_data: string): { key: string; index: number } | null {
	return { key: "bad", index: -1 };
}

export function newApprovalKey(): string {
	return "short";
}

export function isAuthorised(_update: unknown, _cfg: { chatId: string; userIds: number[] }): boolean {
	return false;
}

export function renderApprovalMessage(_input: {
	graphId: string;
	nodeId: string;
	tool: string;
	input: unknown;
	options: Array<{ optionId: string; kind: string; name?: string }>;
}): { text: string; buttons: Array<{ text: string; index: number }> } {
	return { text: "lin_api_aaaaaaaaaaaaaaaaaaaaaaaa ghp_bbbbbbbbbbbbbbbbbbbbbbbb", buttons: [] };
}

export class TelegramError extends Error {
	code: number | null;
	constructor(message: string, code: number | null = null) {
		super(message);
		this.name = "TelegramError";
		this.code = code;
	}
}

export class TelegramClient {
	token: string;
	fetchImpl: typeof fetch;
	constructor(token: string, opts?: { fetchImpl?: typeof fetch }) {
		this.token = token;
		this.fetchImpl = opts?.fetchImpl ?? fetch;
	}
	async call(method: string, _params: Record<string, unknown>): Promise<unknown> {
		throw new TelegramError(`telegram ${method}: request failed (Error https://api.telegram.org/bot${this.token}/${method})`);
	}
}

export class ApprovalBroker {
	async post(_input: {
		graphId: string;
		nodeId: string;
		sessionId: string;
		requestId: string;
		tool: string;
		input: unknown;
		options: Array<{ optionId: string; kind: string; name?: string }>;
	}): Promise<void> {}
	async handleUpdate(_update: unknown): Promise<void> {}
	async pollOnce(): Promise<void> {}
}

export function createApprovals(
	_env: Record<string, string | undefined>,
	_deps?: {
		fetchImpl?: typeof fetch;
		log?: (line: string) => void;
		respond?: (graphId: string, sessionId: string, requestId: string, optionId: string) => Promise<"answered" | "not_pending">;
		statePath?: string;
	},
): ApprovalBroker {
	return new ApprovalBroker();
}
