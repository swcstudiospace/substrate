/**
 * `SUBSTRATE_ANCHOR_SIGNER_SET` (v1.6 phase 59, corrective): the verifier's bootstrap signer set, read from the environment.
 * Unset or blank is no set; a set is parsed by `parseSignerSet`; a value that does not parse is a typed problem that names the
 * rule and the field path and NEVER the value, and leaves the set null (never an empty set the verifier would judge against).
 */
import { describe, expect, test } from "bun:test";
import { configWarnings, loadConfig } from "./config.ts";

// Real 32-byte public keys (the memo program ids), so the base58 check is exercised for real.
const KEY_A = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const KEY_B = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CANARY = "sk-CANARY-do-not-print-0123456789";

const solana = (value: string | undefined) => loadConfig(value === undefined ? {} : { SUBSTRATE_ANCHOR_SIGNER_SET: value }).solana;

describe("SUBSTRATE_ANCHOR_SIGNER_SET: unset and valid", () => {
	test("unset, empty and blank are no set and no problem (the bootstrap stays SOLANA_ANCHOR_PUBKEY)", () => {
		for (const value of [undefined, "", "   "]) {
			expect(solana(value)).toMatchObject({ signerSet: null, signerSetProblem: null });
		}
	});

	test("a valid set is parsed, ordered by start and key, and its pubkey form is untouched", () => {
		const text = JSON.stringify([
			{ pubkey: KEY_B, valid_from_ms: 2000, valid_until_ms: null, label: "new" },
			{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: 2000, label: "old" },
		]);
		const config = loadConfig({ SUBSTRATE_ANCHOR_SIGNER_SET: ` ${text} `, SOLANA_ANCHOR_PUBKEY: KEY_B });
		expect(config.solana.signerSetProblem).toBeNull();
		expect(config.solana.signerSet).toEqual([
			{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: 2000, label: "old" },
			{ pubkey: KEY_B, valid_from_ms: 2000, valid_until_ms: null, label: "new" },
		]);
		expect(config.solana.pubkey).toBe(KEY_B);
		expect(configWarnings(config).filter((warning) => warning.includes("SUBSTRATE_ANCHOR_SIGNER_SET"))).toEqual([]);
	});
});

describe("SUBSTRATE_ANCHOR_SIGNER_SET: malformed values are a problem, never a set, never echoed", () => {
	const cases: Array<[string, string, string]> = [
		["text that is not JSON", `not json ${CANARY}`, "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: not_json"],
		["JSON that is not an array", JSON.stringify({ pubkey: CANARY }), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: not_array"],
		["an empty array (never a silently empty set)", "[]", "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: it names no signer"],
		["an entry that is not an object", JSON.stringify([CANARY]), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: not_object at [0]"],
		["a pubkey that is not a public key", JSON.stringify([{ pubkey: CANARY, valid_from_ms: 0, valid_until_ms: null }]), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: format at [0].pubkey"],
		["a missing window end", JSON.stringify([{ pubkey: KEY_A, valid_from_ms: 0 }]), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: missing at [0].valid_until_ms"],
		["a window that ends before it starts", JSON.stringify([{ pubkey: KEY_A, valid_from_ms: 10, valid_until_ms: 5 }]), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: range at [0].valid_until_ms"],
		[
			"two overlapping windows of one key",
			JSON.stringify([
				{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: null },
				{ pubkey: KEY_A, valid_from_ms: 5, valid_until_ms: null },
			]),
			"SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: overlap at [1].pubkey",
		],
		// The path of an unknown key would be the key's own text, which came from the value: the rule alone is named.
		["an unknown key whose name is a secret", JSON.stringify([{ pubkey: KEY_A, valid_from_ms: 0, valid_until_ms: null, [CANARY]: 1 }]), "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: unknown_key"],
	];
	for (const [name, value, problem] of cases) {
		test(`${name}: signerSet is null, the problem names the rule and path, and no part of the value reaches it or the boot warning`, () => {
			const config = loadConfig({ SUBSTRATE_ANCHOR_SIGNER_SET: value, SOLANA_ANCHOR_PUBKEY: KEY_A });
			expect(config.solana.signerSet).toBeNull();
			expect(config.solana.signerSetProblem).toBe(problem);
			const warnings = configWarnings(config);
			expect(warnings).toContain(`checkpoint_verify and memory_verify answer unverified until SUBSTRATE_ANCHOR_SIGNER_SET is fixed: ${problem}`);
			expect(JSON.stringify([config.solana.signerSetProblem, warnings])).not.toContain("CANARY");
		});
	}

	test("a malformed set does not disturb the other solana settings, and a refused RPC URL is still its own problem", () => {
		const config = loadConfig({ SUBSTRATE_ANCHOR_SIGNER_SET: "{", SOLANA_ANCHOR_PUBKEY: KEY_A, SOLANA_RPC_URL: "https://api.devnet.solana.com" });
		expect(config.solana).toMatchObject({ pubkey: KEY_A, problem: null, rpcUrl: "https://api.devnet.solana.com" });
		expect(config.solana.signerSetProblem).not.toBeNull();
	});
});
