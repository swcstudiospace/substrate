/**
 * Live data-plane clients. Every call fails open: a missing or slow store
 * must not block a prompt. Secrets stay in the environment; nothing here
 * reads a credential from the repo or writes one to a log.
 */
import { connect } from "node:net";
import { spawn } from "node:child_process";

export interface HindsightConfig {
	url: string;
	apiKey: string;
	bank: string;
}

export interface RagflowConfig {
	url: string;
	apiKey: string;
}

export interface SolanaConfig {
	rpcUrl: string;
	keypairPath: string;
}

export interface PlaneConfig {
	hindsight: HindsightConfig | null;
	ragflow: RagflowConfig | null;
	dragonflyUrl: string | undefined;
	solana: SolanaConfig | null;
}

export function planesFromEnv(env: Record<string, string | undefined> = process.env): PlaneConfig {
	const hindsightUrl = env.HINDSIGHT_URL?.trim();
	const hindsightKey = env.HINDSIGHT_API_KEY?.trim();
	const ragflowUrl = env.RAGFLOW_URL?.trim();
	const ragflowKey = env.RAGFLOW_API_KEY?.trim();
	const rpc = env.SOLANA_RPC_URL?.trim();
	const keypair = env.SOLANA_ANCHOR_KEYPAIR?.trim() || env.SOLANA_KEYPAIR_PATH?.trim();
	return {
		hindsight: hindsightUrl && hindsightKey
			? { url: hindsightUrl.replace(/\/+$/, ""), apiKey: hindsightKey, bank: env.HINDSIGHT_BANK?.trim() || "ultrathink" }
			: null,
		ragflow: ragflowUrl && ragflowKey
			? { url: ragflowUrl.replace(/\/+$/, ""), apiKey: ragflowKey }
			: null,
		dragonflyUrl: env.DRAGONFLY_URL?.trim() || undefined,
		solana: rpc && keypair ? { rpcUrl: rpc, keypairPath: keypair } : null,
	};
}

export function parseRedisUrl(raw: string): { host: string; port: number; password?: string } {
	const url = new URL(raw);
	if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
		throw new Error("DRAGONFLY_URL must be a redis URL");
	}
	if (!url.hostname) throw new Error("DRAGONFLY_URL has no host");
	return {
		host: url.hostname,
		port: url.port ? Number(url.port) : 6379,
		password: url.password ? decodeURIComponent(url.password) : undefined,
	};
}

/** RESP array. Values are length-prefixed, so a password cannot break the frame. */
export function encodeCommand(args: string[]): string {
	return `*${args.length}\r\n` + args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("");
}

/** First RESP reply, enough for +PONG, -ERR and a short bulk string. */
export function parseReply(raw: string): string {
	if (raw.startsWith("+") || raw.startsWith("-")) return raw.slice(1).split("\r\n")[0] ?? "";
	if (raw.startsWith("$")) {
		const nl = raw.indexOf("\r\n");
		return nl === -1 ? "" : raw.slice(nl + 2).split("\r\n")[0] ?? "";
	}
	return raw.split("\r\n")[0] ?? "";
}

export function dragonflyCommand(url: string, args: string[], timeoutMs = 3000): Promise<string> {
	const target = parseRedisUrl(url);
	const payload = target.password
		? encodeCommand(["AUTH", target.password]) + encodeCommand(args)
		: encodeCommand(args);
	return new Promise((resolve, reject) => {
		const socket = connect({ host: target.host, port: target.port });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("dragonfly timed out"));
		}, timeoutMs);
		socket.on("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		socket.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks).toString("utf8");
			const replies = raw.split("\r\n").filter((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("$"));
			const need = target.password ? 2 : 1;
			if (replies.length < need) return;
			clearTimeout(timer);
			socket.end();
			const interesting = replies[replies.length - 1] ?? "";
			if (interesting.startsWith("-")) {
				reject(new Error(interesting.slice(1)));
				return;
			}
			resolve(parseReply(interesting.startsWith("$") ? raw.slice(raw.lastIndexOf(interesting)) : interesting));
		});
		socket.on("connect", () => socket.write(payload));
	});
}

export async function hindsightRecall(config: HindsightConfig, query: string, timeoutMs = 4000): Promise<string[]> {
	const response = await fetch(`${config.url}/v1/default/banks/${encodeURIComponent(config.bank)}/memories/recall`, {
		method: "POST",
		headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ query, budget: "low", max_tokens: 400 }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`hindsight ${response.status}`);
	const body = (await response.json()) as { results?: Array<{ text?: string }> };
	return (body.results ?? []).map((row) => row.text).filter((text): text is string => Boolean(text)).slice(0, 4);
}

export async function ragflowSearch(config: RagflowConfig, query: string, timeoutMs = 4000): Promise<string> {
	const response = await fetch(`${config.url}/api/v1/retrieval`, {
		method: "POST",
		headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ question: query, page: 1, page_size: 4 }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) return `ragflow ${response.status}`;
	const body = (await response.json()) as { data?: { chunks?: Array<{ content?: string; document_name?: string }> } };
	const chunks = body.data?.chunks ?? [];
	if (chunks.length === 0) return "ragflow: no chunks";
	return chunks
		.slice(0, 4)
		.map((chunk) => `- ${chunk.document_name ?? "doc"}: ${(chunk.content ?? "").slice(0, 180)}`)
		.join("\n");
}

/** A base58 signature line from `solana transfer`, not a fabricated id. */
export function parseSolanaSignature(output: string): string | null {
	const match = output.match(/\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/);
	return match?.[0] ?? null;
}

export function anchorMemoOnDevnet(
	config: SolanaConfig,
	memo: string,
	run: (args: string[]) => Promise<{ stdout: string; stderr: string; status: number | null }> = runSolana,
): Promise<{ signature?: string; error?: string }> {
	return (async () => {
		// pubkey is derived by the CLI so a stale env pubkey cannot send from the wrong key.
		const who = await run(["address", "-k", config.keypairPath]);
		const destination = who.stdout.trim().split("\n").pop()?.trim();
		if (!destination) return { error: "could not read the anchor pubkey" };
		const sent = await run([
			"transfer",
			destination,
			"0.000001",
			"--from",
			config.keypairPath,
			"--url",
			config.rpcUrl,
			"--with-memo",
			memo.slice(0, 500),
			"--allow-unfunded-recipient",
			"--commitment",
			"confirmed",
		]);
		const signature = parseSolanaSignature(`${sent.stdout}\n${sent.stderr}`);
		if (sent.status === 0 && signature) return { signature };
		const error = (sent.stderr || sent.stdout || "solana transfer failed").replace(config.keypairPath, "[keypair]").slice(0, 300);
		return { error };
	})();
}

function runSolana(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return new Promise((resolve) => {
		const child = spawn("solana", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (status) => resolve({ stdout, stderr, status }));
		child.on("error", (cause) => resolve({ stdout, stderr: String(cause), status: null }));
	});
}
