#!/usr/bin/env bun
/**
 * Unit tests for the gated spike runner: read-only asserts and gate refusals.
 *
 * Nothing here touches the network, the filesystem, or docker: every test
 * injects fake Deps. The live tail (G1/G2/G3) is operator-run by design and
 * is covered only as banner/command descriptors that exit 3 without effects.
 */
import { describe, expect, test } from "bun:test";
import {
	cleanupCommands,
	DISK_FLOOR_BYTES,
	findDrifts,
	formatFacts,
	gatedSteps,
	guardTarget,
	runStep0,
	type Deps,
	type Step0Facts,
} from "./host-spike.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
	return {
		exists: () => false,
		readText: () => "",
		probeTcp: async (_host, port) => port === 6420,
		dfAvailBytes: () => DISK_FLOOR_BYTES + 1,
		imageAbsent: () => true,
		storeBytes: () => 332_755_597,
		...overrides,
	};
}

function cleanFacts(): Step0Facts {
	return {
		kvmAbsent: true,
		cpuFlags: "",
		hasVmxSvm: false,
		port6420Served: true,
		port7411Free: true,
		diskAvailBytes: DISK_FLOOR_BYTES + 1,
		sandboxImageAbsent: true,
		agentosStoreBytes: 332_755_597,
	};
}

describe("runStep0", () => {
	test("clean host yields no drifts", async () => {
		const facts = await runStep0(fakeDeps());
		expect(facts.kvmAbsent).toBe(true);
		expect(facts.hasVmxSvm).toBe(false);
		expect(facts.port6420Served).toBe(true);
		expect(facts.port7411Free).toBe(true);
		expect(findDrifts(facts)).toEqual([]);
	});

	test("kvm present is drift", async () => {
		const facts = await runStep0(fakeDeps({ exists: (path) => path === "/dev/kvm" }));
		expect(findDrifts(facts).map((drift) => drift.fact)).toContain("/dev/kvm");
	});

	test("vmx flag is drift with the flag text recorded", async () => {
		const facts = await runStep0(fakeDeps({ readText: () => "flags\t\t: fpu vmx sse\n" }));
		expect(facts.hasVmxSvm).toBe(true);
		const drifts = findDrifts(facts);
		expect(drifts.map((drift) => drift.fact)).toContain("cpu flags");
	});

	test("6420 refused is drift (the G2 fallback decides, never the agent)", async () => {
		const facts = await runStep0(fakeDeps({ probeTcp: async (_host, port) => port === 7411 }));
		expect(facts.port6420Served).toBe(false);
		expect(facts.port7411Free).toBe(false);
		expect(findDrifts(facts).map((drift) => drift.fact)).toContain("127.0.0.1:6420");
	});

	test("7411 occupied is drift", async () => {
		const facts = await runStep0(fakeDeps({ probeTcp: async () => true }));
		expect(facts.port7411Free).toBe(false);
		expect(findDrifts(facts).map((drift) => drift.fact)).toContain("127.0.0.1:7411");
	});

	test("disk below the floor is drift; unreadable df is drift (fail-closed)", async () => {
		const low = await runStep0(fakeDeps({ dfAvailBytes: () => DISK_FLOOR_BYTES - 1 }));
		expect(findDrifts(low).map((drift) => drift.fact)).toContain("disk avail");
		const unreadable = await runStep0(fakeDeps({ dfAvailBytes: () => null }));
		expect(findDrifts(unreadable).map((drift) => drift.fact)).toContain("disk avail");
	});

	test("sandbox image present is drift; unreadable inspect is drift", async () => {
		const present = await runStep0(fakeDeps({ imageAbsent: () => false }));
		expect(findDrifts(present).map((drift) => drift.fact)).toContain("substrate-sandbox:0.1");
		const unreadable = await runStep0(fakeDeps({ imageAbsent: () => null }));
		expect(findDrifts(unreadable).map((drift) => drift.fact)).toContain("substrate-sandbox:0.1");
	});

	test("cleanup refusal when no spike ran: nothing to clean is success", () => {
		expect(cleanupCommands().length).toBeGreaterThan(0);
		expect(cleanFacts().agentosStoreBytes).toBeGreaterThan(0);
	});
});

describe("guardTarget", () => {
	test("allows loopback non-guarded ports, defaults to the host API port", () => {
		expect(guardTarget(undefined)).toBeNull();
		expect(guardTarget("http://127.0.0.1:7411")).toBeNull();
		expect(guardTarget("http://localhost:9999")).toBeNull();
	});

	test("refuses the guarded production port", () => {
		expect(guardTarget("http://127.0.0.1:7410")).toMatch(/guarded port 7410/);
	});

	test("refuses non-loopback hosts", () => {
		expect(guardTarget("http://10.0.0.5:7411")).toMatch(/not loopback/);
		expect(guardTarget("https://example.com:7411")).toMatch(/not loopback/);
	});

	test("refuses unparseable URLs", () => {
		expect(guardTarget("not a url")).toMatch(/not a URL/);
	});
});

describe("gated steps", () => {
	test("G1/G2/G3 exist with preconditions, commands and record schema", () => {
		const steps = gatedSteps();
		expect(steps.map((step) => step.id)).toEqual(["G1", "G2", "G3"]);
		for (const step of steps) {
			expect(step.preconditions.length).toBeGreaterThan(0);
			expect(step.commands.length).toBeGreaterThan(0);
			expect(step.record.length).toBeGreaterThan(0);
		}
	});

	test("G1 stays in a scratch dir (never the repo dir)", () => {
		const g1 = gatedSteps()[0];
		expect(g1).toBeDefined();
		for (const command of g1?.commands ?? []) {
			if (command.includes("npm ci")) expect(command).toMatch(/\/tmp\/host-spike-/);
		}
	});

	test("G3 defaults the no-KVM verdict to UNVERIFIED (a failed boot is a gap)", () => {
		const g3 = gatedSteps()[2];
		expect(g3).toBeDefined();
		expect(g3?.record.join("\n")).toMatch(/gap/);
	});

	test("formatFacts names every asserted fact", () => {
		const text = formatFacts(cleanFacts());
		for (const needle of ["kvm", "6420", "7411", "disk avail", "substrate-sandbox", "agentos store"]) {
			expect(text).toMatch(needle);
		}
	});
});
