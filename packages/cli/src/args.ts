/**
 * Argument parsing shared by every `substrate` command.
 *
 * Its own module because `index.ts` dispatches at import time, so anything a
 * command module and its tests need has to live somewhere importable.
 */

export type Args = Record<string, string | true>;

/** Parse `--key value` and `--flag` into a map. Unknown keys are kept, not rejected. */
export function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

export function str(value: string | true | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `--files a.ts,b.ts` or `--dod "green;reviewed"` — a list without shell quoting games. */
export function list(value: string | true | undefined): string[] | undefined {
	const raw = str(value);
	if (raw === undefined) return undefined;
	const items = raw
		.split(/[,;\n]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}
