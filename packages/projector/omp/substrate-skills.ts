/**
 * Omp extension (D-11 as relocated by D-17): Omp's skill creator proposes to the shared library
 * instead of writing ~/.omp/agent/managed-skills.
 *
 * Installed as a symlink: ~/.omp/agent/extensions/substrate-skills.ts → this file (Omp's
 * extension loader auto-discovers that directory and accepts symlinks). omp-ultrathink stays
 * disabled and is not involved.
 *
 * - manage_skill create/update → POST /skills/propose, then block with a reason naming the PR.
 * - learn with a skill payload → propose the skill, rewrite the input without it so the memory
 *   lesson still lands, and name the PR in additionalContext.
 * - manage_skill delete and every other tool pass through.
 *
 * Omp's tool_call budget is 30 s and fail-closed, so the request aborts at 25 s. A timeout,
 * transport error, 5xx, 401 or unreadable propose key queues the exact propose body under
 * ~/.omp/agent/substrate-pending/<name>-<UTC ts>.json (0600; the 04-07 bridge drains it with the
 * key) and still blocks/strips. 400 and 413 are final: block with the reason, queue nothing.
 * The handler never throws.
 *
 * The propose key (/var/lib/substrate/skills/propose.key, env SUBSTRATE_PROPOSE_KEY_FILE) is read
 * per call and sent only as the x-substrate-propose-key header: never logged, never queued, never
 * in a reason.
 *
 * No import from @oh-my-pi/* or the repo's module graph: the types below are structural copies of
 * pi-coding-agent's extensibility/shared-events.ts ToolCallEventResult.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
	input?: Record<string, unknown>;
	additionalContext?: string;
}

export interface OmpPi {
	on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined>): void;
}

export interface OmpSkill {
	kind: "manage_skill" | "learn";
	action: string;
	name: string;
	description: string;
	body: string;
}

export interface ProposeBody {
	name: string;
	files: Record<string, string>;
	rationale: string;
	surface: "omp";
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HandlerOptions {
	fetchImpl: FetchLike;
	url: string;
	timeoutMs: number;
	pendingDir: string;
	keyFile: string;
	now?: () => Date;
}

/** Same literal as mcp-server skills/propose.ts SKILL_NAME_RE (copied: this file loads standalone). */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_HEADER = "x-substrate-propose-key";
const KEY_RE = /^[0-9a-f]{64}$/;
const PLAIN_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.;()_/+='?-]*$/;
const YAML_RESERVED_RE = /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d*([eE][-+]?\d+)?|\.inf|\.nan)$/i;

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The skill a tool call would write, or null when the call is not a skill write. */
export function skillFromToolCall(event: Pick<ToolCallEvent, "toolName" | "input">): OmpSkill | null {
	const input = event.input ?? {};
	if (event.toolName === "manage_skill") {
		if (input.action !== "create" && input.action !== "update") return null;
		return { kind: "manage_skill", action: input.action, name: str(input.name), description: str(input.description), body: str(input.body) };
	}
	if (event.toolName === "learn") {
		const skill = input.skill;
		if (skill === null || typeof skill !== "object" || Array.isArray(skill)) return null;
		const s = skill as Record<string, unknown>;
		return { kind: "learn", action: str(s.action) || "create", name: str(s.name), description: str(s.description), body: str(s.body) };
	}
	return null;
}

function yamlScalar(value: string): string {
	return PLAIN_SCALAR_RE.test(value) && !value.endsWith(" ") && !YAML_RESERVED_RE.test(value) ? value : JSON.stringify(value);
}

/** Omp bodies carry no frontmatter (Pitfall 5): synthesize name + description, then the body. */
export function renderSkillMd(skill: { name: string; description: string; body: string }): string {
	const body = skill.body.replace(/\n+$/, "");
	return `---\nname: ${yamlScalar(skill.name)}\ndescription: ${yamlScalar(skill.description)}\n---\n\n${body}\n`;
}

function readKey(keyFile: string): string | null {
	try {
		const key = readFileSync(keyFile, "utf8").trim();
		return KEY_RE.test(key) ? key : null;
	} catch {
		return null;
	}
}

/** A final answer for the model, or the pending file the proposal was queued in. */
type Outcome = { kind: "final"; text: string } | { kind: "queued"; path: string };

function replyError(reply: unknown): string {
	if (reply !== null && typeof reply === "object" && typeof (reply as { error?: unknown }).error === "string") {
		return (reply as { error: string }).error.slice(0, 400);
	}
	return "no error message";
}

function describe(skillName: string, reply: unknown): string {
	const r = (reply ?? {}) as { status?: unknown; pr_url?: unknown };
	const url = typeof r.pr_url === "string" ? r.pr_url : "";
	switch (r.status) {
		case "opened":
		case "existing":
			return `Proposed to the shared skills library as ${url} (${r.status}); it appears in every agent after the owner merges. Nothing was written locally.`;
		case "unchanged":
			return `The library already has this exact skill (${skillName}); nothing was written.`;
		case "declined":
			return `The owner already closed an identical proposal (${url}); it was not proposed again and nothing was written locally.`;
		default:
			return `The substrate answered with an unknown status ${JSON.stringify(String(r.status)).slice(0, 40)}; nothing was written locally.`;
	}
}

export function createHandler(opts: HandlerOptions): (event: ToolCallEvent) => Promise<ToolCallResult | undefined> {
	const now = opts.now ?? (() => new Date());
	const endpoint = `${opts.url.replace(/\/+$/, "")}/skills/propose`;

	function queue(body: ProposeBody): Outcome {
		mkdirSync(opts.pendingDir, { recursive: true, mode: 0o700 });
		const at = now().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, ""); // yyyymmddThhmmssZ
		const path = join(opts.pendingDir, `${body.name}-${at}.json`);
		writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return { kind: "queued", path };
	}

	async function propose(body: ProposeBody): Promise<Outcome> {
		const key = readKey(opts.keyFile);
		if (key === null) return queue(body);
		let res: Response;
		let reply: unknown;
		try {
			res = await opts.fetchImpl(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", [KEY_HEADER]: key },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(opts.timeoutMs),
			});
			reply = await res.json().catch(() => null);
		} catch {
			return queue(body);
		}
		if (res.status === 200) return { kind: "final", text: describe(body.name, reply) };
		if (res.status === 413) {
			return { kind: "final", text: `The skill ${body.name} is too large for the propose route (${replyError(reply)}); nothing was written locally or queued.` };
		}
		if (res.status === 400) {
			return { kind: "final", text: `The substrate refused the skill ${body.name}: ${replyError(reply)}. Nothing was written locally.` };
		}
		if (res.status === 401 || res.status >= 500) return queue(body);
		return { kind: "final", text: `The substrate answered HTTP ${res.status} for the skill ${body.name}; nothing was written locally.` };
	}

	return async (event) => {
		try {
			const skill = skillFromToolCall(event);
			if (skill === null) return undefined;
			if (!SKILL_NAME_RE.test(skill.name)) {
				const reason = `invalid skill name ${JSON.stringify(skill.name.slice(0, 80))}: must match ${SKILL_NAME_RE.source}; nothing was proposed or written.`;
				return { block: true, reason };
			}
			const body: ProposeBody = {
				name: skill.name,
				files: { "SKILL.md": renderSkillMd(skill) },
				rationale: `Omp ${skill.kind} tool (${skill.action}) in an Omp session; routed through the substrate instead of writing ~/.omp/agent/managed-skills.`,
				surface: "omp",
			};
			const outcome = await propose(body);
			const text =
				outcome.kind === "queued"
					? `The substrate was unreachable; the proposal is queued at ${outcome.path} and will be opened as a PR automatically. Nothing was written locally.`
					: outcome.text;
			return skill.kind === "learn" ? strip(event, text) : { block: true, reason: text };
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return { block: true, reason: `substrate-skills extension failed (${message.slice(0, 200)}); nothing was written locally.` };
		}
	};
}

/** learn: the memory lesson still lands; only the skill part is diverted. */
function strip(event: ToolCallEvent, text: string): ToolCallResult {
	const { skill: _skill, ...rest } = event.input;
	return { input: rest, additionalContext: `Skill payload of learn: ${text}` };
}

export default function (pi: OmpPi): void {
	const handler = createHandler({
		fetchImpl: fetch,
		url: process.env.SUBSTRATE_URL ?? "http://127.0.0.1:7410",
		timeoutMs: 25_000,
		pendingDir: process.env.SUBSTRATE_OMP_PENDING_DIR ?? "/root/.omp/agent/substrate-pending",
		keyFile: process.env.SUBSTRATE_PROPOSE_KEY_FILE ?? "/var/lib/substrate/skills/propose.key",
	});
	pi.on("tool_call", handler);
}
