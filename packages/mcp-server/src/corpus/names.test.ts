import { describe, expect, test } from "bun:test";
import { planeDocumentIdForName } from "./names.ts";

describe("the plane's document id", () => {
	test("is doc- plus the MD5 of the name", () => {
		expect(planeDocumentIdForName("abc")).toBe("doc-900150983cd24fb0d6963f7d28e17f72");
	});
});
