import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL } from "@substrate/corpus";
import { parseReconcileRequest } from "./validate.ts";

describe("parseReconcileRequest", () => {
	test("execute true is an execute and false is a dry run; an absent execute is a dry run, so a body that forgot it repairs nothing", () => {
		expect(parseReconcileRequest({ protocol: CORPUS_PROTOCOL, execute: true })).toEqual({ ok: true, value: { protocol: CORPUS_PROTOCOL, execute: true } });
		expect(parseReconcileRequest({ protocol: CORPUS_PROTOCOL, execute: false })).toEqual({ ok: true, value: { protocol: CORPUS_PROTOCOL, execute: false } });
		expect(parseReconcileRequest({ protocol: CORPUS_PROTOCOL })).toEqual({ ok: true, value: { protocol: CORPUS_PROTOCOL, execute: false } });
	});

	test("a body that is not an object, another protocol, or an execute that is not a boolean is refused with its closed reason", () => {
		for (const body of [null, "yes", 7, [true]]) expect(parseReconcileRequest(body)).toMatchObject({ ok: false, reason: "bad-request" });
		expect(parseReconcileRequest({ protocol: 2, execute: true })).toMatchObject({ ok: false, reason: "bad-protocol" });
		for (const execute of ["true", 1, null]) expect(parseReconcileRequest({ protocol: CORPUS_PROTOCOL, execute })).toMatchObject({ ok: false, reason: "bad-request" });
	});
});
