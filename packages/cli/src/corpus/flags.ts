/** The flag parser every `substrate corpus` subcommand shares: `--name value`, `--name=value` and bare booleans, each from a closed list. */

export interface FlagSpec {
	values: readonly string[];
	bools: readonly string[];
}

export interface Parsed {
	values: Map<string, string[]>;
	bools: Set<string>;
}

/** The parsed flags, or the sentence that says what was wrong with them. */
export function parseFlags(argv: readonly string[], spec: FlagSpec): Parsed | string {
	const values = new Map<string, string[]>();
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) return `unexpected argument ${JSON.stringify(arg)}`;
		const eq = arg.indexOf("=");
		const name = arg.slice(2, eq === -1 ? undefined : eq);
		if (spec.bools.includes(name)) {
			if (eq !== -1) return `--${name} takes no value`;
			bools.add(name);
		} else if (spec.values.includes(name)) {
			const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
			if (value === undefined || (eq === -1 && value.startsWith("--")) || value === "") return `--${name} takes a value`;
			if (eq === -1) i += 1;
			values.set(name, [...(values.get(name) ?? []), value]);
		} else {
			return `unknown flag --${name}`;
		}
	}
	return { values, bools };
}

export function positiveInt(text: string | undefined): number | null {
	if (text === undefined || !/^[0-9]+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The last value given for a repeated flag. */
export function last(parsed: Parsed, name: string): string | undefined {
	return parsed.values.get(name)?.at(-1);
}
