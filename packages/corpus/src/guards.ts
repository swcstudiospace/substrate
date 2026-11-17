/**
 * The one object guard of the corpus package, shared by the adapters and the CLI client. It proves "a plain object";
 * every field is still `unknown` and must be checked by the caller before use.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
