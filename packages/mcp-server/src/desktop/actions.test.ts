import { describe, expect, test } from "bun:test";
import {
	boundsRefusal,
	clickArgv,
	DesktopAction,
	DesktopRunInput,
	EXEC,
	geometryArgv,
	keyArgv,
	parseKeys,
	shotArgv,
	titleArgv,
	typeArgv,
} from "./actions.ts";

const SHOT = { type: "screenshot" } as const;
const ok = (value: unknown) => DesktopRunInput.safeParse(value).success;
const actionOk = (value: unknown) => DesktopAction.safeParse(value).success;

describe("DesktopRunInput (D-13 closed vocabulary)", () => {
	test("accepts 1..50 actions and timeout 1..120, defaulting to 30; refuses 0/51 actions and timeout 0/121", () => {
		expect(DesktopRunInput.parse({ actions: [SHOT] }).timeout).toBe(30);
		expect(ok({ actions: Array(50).fill(SHOT), timeout: 1 })).toBe(true);
		expect(ok({ actions: [SHOT], timeout: 120 })).toBe(true);

		expect(ok({ actions: [] })).toBe(false);
		expect(ok({ actions: Array(51).fill(SHOT) })).toBe(false);
		expect(ok({ actions: [SHOT], timeout: 0 })).toBe(false);
		expect(ok({ actions: [SHOT], timeout: 121 })).toBe(false);
	});

	test("refuses an unknown type, an unknown extra field, click x -1 or 1.5, button 4 and settle_ms 5001", () => {
		expect(actionOk({ type: "click", x: 0, y: 0, button: 3, double: true, settle_ms: 5000 })).toBe(true);

		expect(actionOk({ type: "shell", command: "id" })).toBe(false);
		expect(actionOk({ type: "screenshot", path: "/etc/passwd" })).toBe(false);
		expect(actionOk({ type: "click", x: 1, y: 1, argv: ["sh"] })).toBe(false);
		expect(ok({ actions: [SHOT], extra: true })).toBe(false);
		expect(actionOk({ type: "click", x: -1, y: 0 })).toBe(false);
		expect(actionOk({ type: "click", x: 1.5, y: 0 })).toBe(false);
		expect(actionOk({ type: "click", x: 0, y: 0, button: 4 })).toBe(false);
		expect(actionOk({ type: "key", keys: "Return", settle_ms: 5001 })).toBe(false);
	});

	test("type text accepts shell-looking text, newline and tab; refuses empty, 2,001 characters, BEL and ESC", () => {
		expect(actionOk({ type: "type", text: "PS1='$ '; printf '\\033]0;t\\007'" })).toBe(true);
		expect(actionOk({ type: "type", text: "a\nb\tc" })).toBe(true);
		expect(actionOk({ type: "type", text: "x".repeat(2000) })).toBe(true);

		expect(actionOk({ type: "type", text: "" })).toBe(false);
		expect(actionOk({ type: "type", text: "x".repeat(2001) })).toBe(false);
		expect(actionOk({ type: "type", text: "ring\u0007" })).toBe(false);
		expect(actionOk({ type: "type", text: "\u001b]0;title" })).toBe(false);
	});
});

describe("key grammar", () => {
	test("accepts chords and chord sequences", () => {
		expect(parseKeys("ctrl+alt+t")).toEqual(["ctrl+alt+t"]);
		expect(parseKeys("Return")).toEqual(["Return"]);
		expect(parseKeys("ctrl+alt+t Return")).toEqual(["ctrl+alt+t", "Return"]);
		expect(parseKeys(Array(8).fill("a").join(" "))).toHaveLength(8);
		expect(actionOk({ type: "key", keys: "ctrl+alt+t Return" })).toBe(true);
	});

	test("refuses empty, 9 chords, punctuation, substitution, an option and an empty chord", () => {
		for (const keys of ["", Array(9).fill("a").join(" "), "ctrl+;", "$(id)", "--help", "a  b"]) {
			expect(() => parseKeys(keys)).toThrow();
			expect(actionOk({ type: "key", keys })).toBe(false);
		}
	});
});

describe("argv builders", () => {
	test("typed text that looks like an option stays one element after --", () => {
		const argv = typeArgv({ type: "type", text: "-rf x" });

		expect(argv.slice(-2)).toEqual(["--", "-rf x"]);
		expect(argv.filter((a) => a === "-rf x")).toHaveLength(1);
	});

	test("no builder emits a shell or a program outside xdotool/xwd", () => {
		const all = [
			clickArgv({ type: "click", x: 1, y: 1, double: true }),
			typeArgv({ type: "type", text: "sh -c id; bash" }),
			keyArgv({ type: "key", keys: "ctrl+alt+t" }),
			shotArgv(),
			titleArgv(),
			geometryArgv(),
		];
		for (const argv of all) {
			expect(argv.slice(0, 5)).toEqual([...EXEC]);
			expect(["xdotool", "xwd"]).toContain(argv[5]!);
			expect(argv.slice(0, 6)).not.toContain("sh");
			expect(argv).not.toContain("bash");
			expect(argv).not.toContain("-c");
		}
	});
});

describe("boundsRefusal", () => {
	const geometry = { width: 1280, height: 800 };

	test("refuses x 1280 or y 800 and accepts 1279/799", () => {
		expect(boundsRefusal([{ type: "click", x: 1279, y: 799 }, SHOT], geometry)).toBeNull();
		expect(boundsRefusal([SHOT, { type: "click", x: 1280, y: 0 }], geometry)).toContain("1280");
		expect(boundsRefusal([{ type: "click", x: 0, y: 800 }], geometry)).toContain("800");
	});
});
