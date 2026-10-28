#!/usr/bin/env bun
/**
 * Mirror rehearsal smoke for Phase 23 (claim mirror + DoD gate).
 *
 * Proves every lease transition against loopback tracker fakes, with
 * wire-level effect assertions on the fakes' recorded requests — not the
 * server's replies alone:
 *
 * claim → a second surface's refused claim → release → reclaim (+ a silent
 * heartbeat) → complete without DoD (`dod-required`) → complete with DoD
 * (approval), plus a steal, a forced release, a reap and a swarm claim.
 *
 * Isolation: sources only `consumer.env` (for `SUBSTRATE_TEST_PG_URL`),
 * refuses production ports and non-loopback hosts, stands its fakes up on
 * ephemeral loopback ports, and drives the real service layer (real
 * `IndexStore` on the scratch Postgres, real `Mirror`/`LinearClient`/
 * `NotionClient`, real `runDodGate`) with random scratch tracker keys.
 * Zero production writes: the only stores touched are the fakes and the
 * scratch Postgres row range under this run's graph id.
 *
 * Exit codes: 0 pass, 1 a transition's effects mismatched (names it),
 * 2 precondition refused (no consumer.env, no scratch PG, production port).
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { IndexStore } from "../packages/mcp-server/src/index-store.ts";
import { Substrate } from "../packages/mcp-server/src/service.ts";
import { parseConsumerEnv, refuseTarget } from "./vocabulary-smoke.ts";

const RUN = `rh-mirror-${Date.now()}`;
const GRAPH = `${RUN}-g`;
const REPO = "rehearsal/mirror-smoke";
const EXPIRY_WAIT_MS = 33_000;

interface LinearLabel {
	id: string;
	name: string;
}
interface LinearIssue {
	id: string;
	identifier: string;
	stateId: string;
	labels: LinearLabel[];
	comments: string[];
	title: string;
	description: string;
}
interface LinearRequest {
	op: string;
	variables: Record<string, unknown>;
}
interface NotionRequest {
	method: string;
	page: string;
	body: unknown;
}

const STATES = [
	{ id: "state-todo", name: "Todo", type: "unstarted", position: 0 },
	{ id: "state-progress", name: "In Progress", type: "started", position: 1 },
	{ id: "state-review", name: "In Review", type: "started", position: 2 },
] as const;
const TEAM_ID = "team-rh";
const DONE_ID = "state-done";

interface FakeWorld {
	issues: Map<string, LinearIssue>;
	byIdentifier: Map<string, LinearIssue>;
	labels: Map<string, LinearLabel>;
	linear: LinearRequest[];
	notion: NotionRequest[];
	connector: Array<Record<string, unknown>>;
	notionDs: string;
}

function issueRef(issue: LinearIssue): Record<string, unknown> {
	return {
		id: issue.id,
		identifier: issue.identifier,
		team: { id: TEAM_ID, key: "RHM", states: { nodes: [...STATES] } },
		labels: { nodes: issue.labels.map((l) => ({ ...l })) },
		comments: { nodes: issue.comments.map((body) => ({ body })) },
	};
}

function linearResponse(world: FakeWorld, body: { query: string; variables: Record<string, unknown> }): Response {
	const { query, variables } = body;
	const json = (data: unknown, status = 200): Response => Response.json({ data }, { status });
	const byRef = (ref: unknown): LinearIssue | null => {
		if (typeof ref !== "string") return null;
		return world.issues.get(ref) ?? world.byIdentifier.get(ref) ?? null;
	};
	if (query.includes("IssueContext")) {
		const issue = byRef(variables["id"]);
		return json({ issue: issue ? issueRef(issue) : null });
	}
	if (query.includes("IssueState")) {
		const issue = byRef(variables["id"]);
		if (!issue) return json({ issue: null });
		const state = issue.stateId === DONE_ID ? { name: "Done", type: "completed" } : STATES.find((s) => s.id === issue.stateId);
		return json({ issue: { state: { name: state?.name ?? issue.stateId, type: state?.type ?? "unstarted" } } });
	}
	if (query.includes("IssueText")) {
		const issue = byRef(variables["id"]);
		return json({ issue: issue ? { identifier: issue.identifier, title: issue.title, description: issue.description } : null });
	}
	if (query.includes("issueLabels(")) {
		const name = variables["name"];
		const nodes = [...world.labels.values()]
			.filter((l) => l.name === name)
			.map((l) => ({ id: l.id, name: l.name, team: { id: TEAM_ID } }));
		return json({ issueLabels: { nodes } });
	}
	if (query.includes("issueLabelCreate")) {
		const input = variables["input"] as { name: string };
		const label = { id: `label-${randomBytes(4).toString("hex")}`, name: input.name };
		world.labels.set(label.id, label);
		return json({ issueLabelCreate: { success: true, issueLabel: { id: label.id } } });
	}
	if (query.includes("issueUpdate")) {
		const id = variables["id"];
		const input = variables["input"] as { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] };
		const issue = typeof id === "string" ? world.issues.get(id) : undefined;
		if (!issue) return json({ errors: [{ message: "issue not found" }] }, 200);
		if (input.stateId) issue.stateId = input.stateId;
		for (const labelId of input.addedLabelIds ?? []) {
			const label = world.labels.get(String(labelId));
			if (label && !issue.labels.some((l) => l.id === label.id)) issue.labels.push({ ...label });
		}
		issue.labels = issue.labels.filter((l) => !(input.removedLabelIds ?? []).map(String).includes(l.id));
		return json({ issueUpdate: { success: true } });
	}
	if (query.includes("commentCreate")) {
		const input = variables["input"] as { issueId: string; body: string };
		world.issues.get(input.issueId)?.comments.push(input.body);
		return json({ commentCreate: { success: true } });
	}
	return json({ errors: [{ message: "unknown operation" }] }, 400);
}

function notionResponse(world: FakeWorld, method: string, page: string, body: unknown): Response {
	if (method === "GET") {
		return Response.json({
			parent: { type: "data_source_id", data_source_id: world.notionDs },
			properties: {
				Agent: { type: "rich_text" },
				Status: { type: "status" },
				"Linear State": { type: "select" },
				Completed: { type: "date" },
			},
		});
	}
	world.notion.push({ method, page, body });
	return Response.json({});
}

function connectorResponse(world: FakeWorld, body: Record<string, unknown>): Response {
	world.connector.push(body);
	const summary = typeof body["summary"] === "string" ? body.summary : "";
	if (body["tests_pass"] === true && summary.trim().length > 0) {
		const ref = String(body["linear_issue_id"] ?? "");
		const issue = world.issues.get(ref) ?? world.byIdentifier.get(ref);
		if (issue) issue.stateId = DONE_ID;
		return Response.json({ completed: true, reason: "dod satisfied", linear_issue_id: body["linear_issue_id"] });
	}
	return Response.json({ completed: false, reason: "checks-unmet", linear_issue_id: body["linear_issue_id"] });
}

const failures: string[] = [];
let checks = 0;
function check(step: string, cond: boolean, detail = ""): void {
	checks += 1;
	if (cond) {
		process.stdout.write(`  ok   ${step}\n`);
	} else {
		failures.push(detail ? `${step}: ${detail}` : step);
		process.stdout.write(`  FAIL ${step}${detail ? ` — ${detail}` : ""}\n`);
	}
}

const sleep = (ms: number): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

export async function main(argv: string[]): Promise<number> {
	const at = argv.indexOf("--name");
	const name = at >= 0 && argv[at + 1] ? (argv[at + 1] as string) : "default";
	const envPath = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "substrate-rehearsal", name, "consumer.env");
	if (!existsSync(envPath)) {
		process.stderr.write(`[mirror-smoke] no consumer.env for instance ${name}: run rehearsal up first.\n`);
		return 2;
	}
	const record = parseConsumerEnv(readFileSync(envPath, "utf8"));
	const twin = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const twinRefused = twin ? refuseTarget(twin) : "consumer.env has no twin url";
	if (twinRefused !== null) {
		process.stderr.write(`[mirror-smoke] ${twinRefused}.\n`);
		return 2;
	}
	const pgUrl = record["SUBSTRATE_TEST_PG_URL"] ?? "";
	let pgHost = "";
	try {
		pgHost = new URL(pgUrl).hostname.replace(/^\[(.*)\]$/, "$1");
	} catch {
		process.stderr.write("[mirror-smoke] consumer.env has no usable SUBSTRATE_TEST_PG_URL.\n");
		return 2;
	}
	if (pgHost !== "127.0.0.1" && pgHost !== "::1" && pgHost !== "localhost") {
		process.stderr.write(`[mirror-smoke] refusing non-loopback scratch postgres ${pgHost}.\n`);
		return 2;
	}

	const world: FakeWorld = { issues: new Map(), byIdentifier: new Map(), labels: new Map(), linear: [], notion: [], connector: [], notionDs: "" };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		routes: {
			"/graphql": {
				POST: async (req) => {
					const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
					const op = body.query.includes("IssueContext")
						? "IssueContext"
						: body.query.includes("IssueState")
							? "IssueState"
							: body.query.includes("IssueText")
								? "IssueText"
								: body.query.includes("issueLabels(")
									? "Labels"
									: body.query.includes("issueLabelCreate")
										? "LabelCreate"
										: body.query.includes("issueUpdate")
											? "IssueUpdate"
											: body.query.includes("commentCreate")
												? "CommentCreate"
												: "unknown";
					world.linear.push({ op, variables: body.variables });
					return linearResponse(world, body);
				},
			},
			"/v1/complete-issue": {
				POST: async (req) => connectorResponse(world, (await req.json()) as Record<string, unknown>),
			},
			"/notion/pages/:id": {
				GET: (req) => notionResponse(world, "GET", new URL(req.url).pathname.split("/").pop() ?? "", null),
				PATCH: async (req) => {
					const page = new URL(req.url).pathname.split("/").pop() ?? "";
					return notionResponse(world, "PATCH", page, (await req.json()) as unknown);
				},
			},
		},
	});
	const fakeBase = `http://127.0.0.1:${server.port}`;

	const env: Record<string, string> = {
		SUBSTRATE_PG_URL: pgUrl,
		LINEAR_API_KEY: `rh-linear-${randomBytes(8).toString("hex")}`,
		NOTION_API_KEY: `rh-notion-${randomBytes(8).toString("hex")}`,
		LINEAR_API_URL: `${fakeBase}/graphql`,
		NOTION_API_URL: `${fakeBase}/notion`,
		HERMES_LINEAR_URL: fakeBase,
		SUBSTRATE_DOD_GATE_TIMEOUT_MS: "5000",
	};
	const config = loadConfig(env);
	world.notionDs = config.notionTaskGraphDataSource;

	const pageHex = (seed: string): string => `https://notion.so/${seed.repeat(32).slice(0, 32)}`;
	const nodes = ["n1", "n2", "n3", "n4", "n5"].map((nodeId, i) => {
		const id = `uuid-rhm-${RUN}-${nodeId}`;
		const identifier = `RHM-${100 + i}`;
		const issue: LinearIssue = {
			id,
			identifier,
			stateId: "state-todo",
			labels: [],
			comments: [],
			title: `Rehearsal ${identifier}`,
			description: "loopback rehearsal issue",
		};
		world.issues.set(id, issue);
		world.byIdentifier.set(identifier, issue);
		return { node_id: nodeId, linear_issue_id: id, linear_identifier: identifier, notion_page: pageHex(`${i + 1}`) };
	});
	const issueOf = (nodeId: string): LinearIssue => world.byIdentifier.get(`RHM-${100 + Number(nodeId.slice(1)) - 1}`)!;

	const index = new IndexStore(config.postgresUrl!);
	await index.migrate();
	const substrate = new Substrate(config, { index, greptime: null });
	await index.registerGraph({ graph_id: GRAPH, repo: REPO, branch: "main", nodes });

	process.stdout.write(`\nMirror smoke — ${name}, graph ${GRAPH}\n\n`);
	const linearOps = (op: string, nodeId?: string): LinearRequest[] =>
		world.linear.filter(
			(r) => r.op === op && (nodeId === undefined || JSON.stringify(r.variables).includes(issueOf(nodeId).id)),
		);
	const notionPatches = (): NotionRequest[] => world.notion.filter((r) => r.method === "PATCH");

	// 1. Claim n1 as hermes: first started state, agent label, dispatch cleanup, claim comment, Notion row.
	const claimed = await substrate.claimNode(GRAPH, "n1", "hermes", `${RUN}-s1`, "hermes");
	check("claim granted", claimed.claimed === true, JSON.stringify(claimed).slice(0, 200));
	const lease1 = claimed.claimed && claimed.lease.lease_id ? String(claimed.lease.lease_id) : "";
	const updates1 = linearOps("IssueUpdate", "n1");
	check("claim sets In Progress with the agent label", updates1.length === 1, `${updates1.length} updates`);
	check(
		"claim update carries state and added label only",
		JSON.stringify(updates1[0]?.variables).includes("state-progress") &&
			JSON.stringify(updates1[0]?.variables).includes("addedLabelIds"),
		JSON.stringify(updates1[0]?.variables).slice(0, 200),
	);
	const comments1 = linearOps("CommentCreate", "n1");
	check("claim posts the exact claim comment", comments1.length === 1, `${comments1.length} comments`);
	check(
		"claim comment names surface, session, graph and node",
		String((comments1[0]?.variables as { input?: { body?: string } })?.input?.body).includes(
			`Claimed by hermes — session ${RUN}-s1 (graph ${GRAPH}, node n1)`,
		),
	);
	check("claim writes the Notion row", notionPatches().length === 1, `${notionPatches().length} patches`);
	check("fake issue is In Progress", issueOf("n1").stateId === "state-progress", issueOf("n1").stateId);

	// 2. A losing claimant writes nothing.
	const linearBefore = world.linear.length;
	const notionBefore = world.notion.length;
	const denied = await substrate.claimNode(GRAPH, "n1", "omp", `${RUN}-s2`, "omp");
	check("second-surface claim refused", denied.claimed === false, JSON.stringify(denied).slice(0, 160));
	check("losing claimant writes nothing", world.linear.length === linearBefore && world.notion.length === notionBefore);

	// 3. Release: first unstarted state, every agent label off, no comment, Notion cleared.
	const released = await substrate.releaseNode(GRAPH, "n1", { lease_id: lease1 }, "hermes");
	check("release granted", released.released === true);
	const updatesRel = linearOps("IssueUpdate", "n1");
	check(
		"release sets Todo and removes the agent label",
		updatesRel.length === 2 && JSON.stringify(updatesRel[1]?.variables).includes("state-todo"),
		`${updatesRel.length} updates`,
	);
	check("release posts no comment", linearOps("CommentCreate", "n1").length === 1);
	check("fake issue is Todo with no agent label", issueOf("n1").stateId === "state-todo" && issueOf("n1").labels.length === 0);

	// 4. Reclaim, then a heartbeat renewal writes nothing.
	const reclaimed = await substrate.claimNode(GRAPH, "n1", "hermes", `${RUN}-s3`, "hermes");
	check("reclaim granted", reclaimed.claimed === true);
	const lease2 = reclaimed.claimed && reclaimed.lease.lease_id ? String(reclaimed.lease.lease_id) : "";
	check(
		"reclaim posts its own session comment",
		linearOps("CommentCreate", "n1").length === 2 &&
			String((linearOps("CommentCreate", "n1")[1]?.variables as { input?: { body?: string } })?.input?.body).includes(
				`${RUN}-s3`,
			),
	);
	const wireBefore = world.linear.length + world.notion.length;
	const beat = await substrate.heartbeatNode(GRAPH, "n1", lease2, "hermes");
	check("heartbeat ok", beat.ok === true);
	check("renewed path writes nothing", world.linear.length + world.notion.length === wireBefore);

	// 5. Complete without DoD: review mirror runs, connector never called, node parks.
	const required = await substrate.completeNode(GRAPH, "n1", { lease_id: lease2 }, "hermes");
	check("no-dod completion refused dod-required", (required as { reason?: string }).reason === "dod-required");
	check("connector never called without dod", world.connector.length === 0);
	const reviewUpdates = linearOps("IssueUpdate", "n1");
	check(
		"review moves the issue to In Review",
		reviewUpdates.length === 4 && JSON.stringify(reviewUpdates[3]?.variables).includes("state-review"),
		`${reviewUpdates.length} updates`,
	);
	check("node parks at started_review", (await index.getNode(GRAPH, "n1"))?.state === "started_review");

	// 6. Complete with DoD: connector approval, fenced completion, Notion done.
	const dod = { summary: "mirror smoke approval", tests_pass: true };
	const approved = await substrate.completeNode(GRAPH, "n1", { lease_id: lease2, dod }, "hermes");
	check("dod completion approved", (approved as { completed?: boolean }).completed === true);
	check("connector called once", world.connector.length === 1, `${world.connector.length} calls`);
	check(
		"connector body matches the versioned fixture",
		JSON.stringify(world.connector[0]) ===
			JSON.stringify({ linear_issue_id: issueOf("n1").id, summary: dod.summary, tests_pass: true }),
		JSON.stringify(world.connector[0]).slice(0, 200),
	);
	check("node completed and lease cleared", (await index.getNode(GRAPH, "n1"))?.state === "completed");
	const donePatches = notionPatches();
	const donePatch = donePatches[donePatches.length - 1];
	check(
		"Notion records the done write",
		JSON.stringify(donePatch?.body).includes("Done"),
		JSON.stringify(donePatch?.body).slice(0, 200),
	);

	// 7. Steal and reap need lapsed leases: claim short, then wait them out.
	const short2 = await substrate.claimNode(GRAPH, "n2", "hermes", `${RUN}-s4`, "hermes", 30);
	const short3 = await substrate.claimNode(GRAPH, "n3", "hermes", `${RUN}-s5`, "hermes", 30);
	check("short claims granted", short2.claimed === true && short3.claimed === true);
	process.stdout.write(`  .... waiting ${EXPIRY_WAIT_MS / 1000}s for the short leases to lapse\n`);
	await sleep(EXPIRY_WAIT_MS);

	const stolen = await substrate.claimNode(GRAPH, "n2", "omp", `${RUN}-s6`, "omp");
	check("steal granted to the new holder", stolen.claimed === true && (stolen as { action?: string }).action === "stolen");
	check(
		"steal moves the agent label to the new holder",
		issueOf("n2").labels.some((l) => l.name === "agent:omp") && !issueOf("n2").labels.some((l) => l.name === "agent:hermes"),
		JSON.stringify(issueOf("n2").labels),
	);

	const reaped = await substrate.reapExpiredLeases(REPO);
	check("reaper reports the lapsed n3 lease", reaped.some((l) => l.node_id === "n3"), JSON.stringify(reaped.map((l) => l.node_id)));
	check("reaped issue is Todo with no agent label", issueOf("n3").stateId === "state-todo" && issueOf("n3").labels.length === 0);

	// 8. Forced release mirrors close: labels off, Linear state untouched by Done.
	const forceClaim = await substrate.claimNode(GRAPH, "n5", "hermes", `${RUN}-s7`, "hermes");
	const forceLease = forceClaim.claimed && forceClaim.lease.lease_id ? String(forceClaim.lease.lease_id) : "";
	check("pre-force claim granted", forceClaim.claimed === true && forceLease.length > 0);
	const forced = await substrate.releaseNode(GRAPH, "n5", { force: true }, "claude-code");
	check("forced release reported", (forced as { action?: string }).action === "forced");
	check(
		"force clears labels without moving Linear toward Done",
		issueOf("n5").labels.length === 0 && issueOf("n5").stateId !== DONE_ID,
		issueOf("n5").stateId,
	);

	// 9. Swarm claim: exactly one comment, and nothing else.
	const swarmLinear = world.linear.length;
	const swarmNotion = world.notion.length;
	const swarm = await substrate.claimNode(GRAPH, "n4", "swarm-a01-orch", `${RUN}-s8`, "swarm-a01-orch");
	check("swarm claim granted", swarm.claimed === true);
	const swarmWrites = world.linear.slice(swarmLinear);
	const swarmMutations = swarmWrites.filter((r) => r.op === "IssueUpdate" || r.op === "LabelCreate" || r.op === "CommentCreate");
	check(
		"swarm writes exactly one comment",
		swarmMutations.length === 1 && swarmMutations[0]?.op === "CommentCreate",
		JSON.stringify(swarmMutations.map((r) => r.op)),
	);
	check("swarm touches no Notion row", world.notion.length === swarmNotion);
	check("swarm changes no Linear state or labels", issueOf("n4").stateId === "state-todo" && issueOf("n4").labels.length === 0);

	server.stop();
	process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
	for (const failure of failures) process.stdout.write(` MISMATCH ${failure}\n`);
	return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
