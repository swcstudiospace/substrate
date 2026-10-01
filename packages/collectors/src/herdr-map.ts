/**
 * Map herdr/OMP session events onto substrate events.
 *
 * herdr (the persistent runtime) surfaces agent sessions via ~/.omp/agent/sessions
 * (referenced from ~/.config/herdr/session.json). Each <encoded-cwd>/<ts>_<uuid>.jsonl
 * is a stream of OMP-style JSON events.
 *
 * Filter first (drop thinking, raw text, history, internal), translate the rest.
 * This keeps the brief usable.
 */
import type { EventInput } from "../../mcp-server/src/types.ts";

export interface HerdrEvent {
	type?: string;
	timestamp?: string;
	id?: string;
	version?: unknown;
	model?: string;
	customType?: string;
	data?: {
		toolName?: string;
		args?: Record<string, unknown>;
		intent?: string;
		startedAt?: string;
		toolCallId?: string;
	};
	message?: {
		role?: string;
		content?: unknown[];
		toolName?: string;
		toolCallId?: string;
	};
	[key: string]: unknown;
}

export interface HerdrContext {
	/** Session UUID from the filename/dir. */
	sessionId: string;
	repo?: string;
	branch?: string;
	cwd?: string | null;
}

/**
 * Types deliberately dropped:
 *
 *   thinking / reasoning / summary_text / openaiResponsesHistory   — internal CoT, high volume
 *   text / path / task / internal / report                          — noise or redundant
 *   title / title_change                                            — UI only
 */
const DROPPED: Record<string, true> = {
	thinking: true,
	reasoning: true,
	summary_text: true,
	openaiResponsesHistory: true,
	text: true,
	path: true,
	task: true,
	internal: true,
	report: true,
	title: true,
	title_change: true,
	function_call: true,
	toolCall: true,
};

export function decodeHerdrCwd(dirName: string): string | null {
	if (!dirName || dirName === ".") return null;
	let p = dirName;
	if (p.startsWith("-")) {
		p = "/root" + p.replace(/-/g, "/");
	} else {
		p = p.replace(/-/g, "/");
	}
	p = p.replace(/\/+/g, "/");
	if (p.startsWith("/root/") || p.startsWith("/")) {
		return p.replace(/\/+$/, "") || "/";
	}
	return null;
}

/**
 * One herdr/omp event → substrate EventInput or null to drop.
 */
export function mapHerdrEvent(event: HerdrEvent, context: HerdrContext): EventInput | null {
	const type = event.type;
	if (!type || DROPPED[type]) return null;

	const ts = typeof event.timestamp === "string" ? event.timestamp : (typeof event.data?.startedAt === "string" ? event.data.startedAt : undefined);
	const base = {
		surface: "omp" as const,
		session_id: context.sessionId,
		repo: context.repo,
		branch: context.branch,
		ts,
	};

	if (type === "session") {
		return {
			...base,
			kind: "session.start",
			summary: `herdr/omp session started${context.cwd ? ` in ${context.cwd}` : ""}`,
			payload: { cwd: event.cwd ?? context.cwd, version: event.version },
		};
	}

	if (type === "model_change") {
		return {
			...base,
			kind: "prompt",
			summary: `model changed to ${event.model ?? "unknown"}`,
			payload: { model: event.model },
		};
	}

	if (type === "custom" && event.customType === "tool_execution_start") {
		const tool = typeof event.data?.toolName === "string" ? event.data.toolName : "unknown";
		const intentStr = typeof event.data?.intent === "string" ? event.data.intent.slice(0, 120) : "";
		const intent = intentStr ? ` — ${intentStr}` : "";
		return {
			...base,
			kind: "tool.call",
			summary: `${tool}${intent}`,
			payload: {
				tool,
				args: event.data?.args,
				intent: event.data?.intent,
				toolCallId: event.data?.toolCallId,
			},
		};
	}

	// Tool results that carry content are useful as notes (outcome)
	if (type === "message" && event.message?.role === "toolResult") {
		const tool = typeof event.message?.toolName === "string" ? event.message.toolName : "tool";
		let contentPreview = "";
		const contents = event.message?.content;
		if (Array.isArray(contents) && contents.length > 0) {
			const first = contents[0];
			if (first && typeof first === "object" && first !== null && "text" in first) {
				const t = (first as { text?: unknown }).text;
				if (typeof t === "string") contentPreview = t.slice(0, 100);
			}
		}
		return {
			...base,
			kind: "tool.call",
			summary: `${tool} result${contentPreview ? `: ${contentPreview}` : ""}`,
			payload: { tool, role: "toolResult", preview: contentPreview || undefined },
		};
	}

	// Assistant messages that are not pure thinking are light notes (avoid flooding)
	if (type === "message" && event.message?.role === "assistant") {
		const contents = event.message?.content;
		let hasNonThinking = false;
		if (Array.isArray(contents)) {
			for (const c of contents) {
				if (c && typeof c === "object" && c !== null && !("thinking" in (c as object))) {
					hasNonThinking = true;
					break;
				}
			}
		}
		if (!hasNonThinking) return null;
		return {
			...base,
			kind: "note",
			summary: "omp assistant turn",
			payload: { role: "assistant" },
		};
	}

	// Fallback: record unknown-but-not-dropped so we don't lose future event kinds silently
	const ct = event.customType ? `/${event.customType}` : "";
	return {
		...base,
		kind: "note",
		summary: `herdr ${type}${ct}`,
	};
}