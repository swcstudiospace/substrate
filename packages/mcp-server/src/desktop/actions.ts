/**
 * desktop_run's closed action vocabulary (DESK-01 / D30-05..D30-06): four validated action kinds
 * and the fixed argv each one becomes. The caller never supplies a program, a flag or a shell —
 * only the fields below — and every argv is `docker exec -e DISPLAY=:1 substrate-desktop` +
 * xdotool or xwd.
 */
import { z } from "zod";

export const EXEC = ["docker", "exec", "-e", "DISPLAY=:1", "substrate-desktop"] as const;

/** One chord is `name` or `mod+…+name`; a sequence is 1..8 chords separated by single spaces. */
const CHORD = "[A-Za-z0-9_]+(?:\\+[A-Za-z0-9_]+)*";
const KEYS = new RegExp(`^${CHORD}(?: ${CHORD}){0,7}$`);
const KEYS_RULE = "keys must be 1..8 space-separated chords of [A-Za-z0-9_] names joined by +, e.g. ctrl+alt+t Return";
/** Printable text plus \n and \t: no other C0 control, DEL or C1 control. */
const TYPEABLE = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/;

const settleMs = z.number().int().min(0).max(5000).optional().describe("wait after the action, ms");

export const DesktopAction = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("click"),
		x: z.number().int().min(0),
		y: z.number().int().min(0),
		button: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("1 left (default), 2 middle, 3 right"),
		double: z.boolean().optional(),
		settle_ms: settleMs,
	}),
	z.strictObject({
		type: z.literal("type"),
		text: z
			.string()
			.min(1)
			.max(2000)
			.regex(TYPEABLE, "text may contain no control characters other than newline and tab")
			.describe("typed as keystrokes; \\n presses Return"),
		settle_ms: settleMs,
	}),
	z.strictObject({
		type: z.literal("key"),
		keys: z.string().regex(KEYS, KEYS_RULE).describe("xdotool key chords, e.g. ctrl+alt+t or Return"),
		settle_ms: settleMs,
	}),
	z.strictObject({ type: z.literal("screenshot") }),
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

export const DesktopRunInput = z.strictObject({
	actions: z.array(DesktopAction).min(1).max(50),
	timeout: z.number().int().min(1).max(120).default(30).describe("whole-run deadline in seconds"),
});
export type DesktopRunInput = z.infer<typeof DesktopRunInput>;

type Click = Extract<DesktopAction, { type: "click" }>;
type TypeText = Extract<DesktopAction, { type: "type" }>;
type Key = Extract<DesktopAction, { type: "key" }>;

export const DEFAULT_SETTLE_MS = { click: 300, type: 200, key: 800 } as const;

/** The chords of a key action; throws on anything outside the grammar. */
export function parseKeys(keys: string): string[] {
	if (!KEYS.test(keys)) throw new Error(KEYS_RULE);
	return keys.split(" ");
}

/** Why the run must not start — a click outside the display read at the start of the run — or null. */
export function boundsRefusal(
	actions: readonly DesktopAction[],
	geometry: { width: number; height: number },
): string | null {
	for (const [i, action] of actions.entries()) {
		if (action.type === "click" && (action.x >= geometry.width || action.y >= geometry.height)) {
			return `action ${i}: click (${action.x}, ${action.y}) is outside the ${geometry.width}x${geometry.height} display`;
		}
	}
	return null;
}

export function clickArgv(action: Click): string[] {
	return [
		...EXEC,
		"xdotool",
		"mousemove",
		"--sync",
		String(action.x),
		String(action.y),
		"click",
		...(action.double ? ["--repeat", "2"] : []),
		String(action.button ?? 1),
	];
}

/** `--` ends option parsing, so text starting with `-` is typed, not parsed. */
export function typeArgv(action: TypeText): string[] {
	return [...EXEC, "xdotool", "type", "--delay", "12", "--", action.text];
}

export function keyArgv(action: Key): string[] {
	return [...EXEC, "xdotool", "key", "--clearmodifiers", "--", ...parseKeys(action.keys)];
}

export function shotArgv(): string[] {
	return [...EXEC, "xwd", "-root", "-silent"];
}

export function titleArgv(): string[] {
	return [...EXEC, "xdotool", "getactivewindow", "getwindowname"];
}

export function geometryArgv(): string[] {
	return [...EXEC, "xdotool", "getdisplaygeometry"];
}

/**
 * The locality probe: the effective docker endpoint with the same client
 * config the child sees. Client-local (`context`, never `exec`), so it moves
 * no input and touches no desktop wherever it points.
 */
export function contextArgv(): string[] {
	return ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"];
}
