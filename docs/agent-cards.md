# Agent Cards and teachable moments (Phase 29)

## The teachable convention

A teachable is a governed `fact` whose subject starts with `teachable:`
(e.g. `teachable:retry-budget`), written through `memory_write`. No new
memory kind, no tags field, no schema change. The subject carries the tag for
two load-bearing reasons: the conflict key is `scope|kind|subject`, so a
teachable is addressable per topic, and the index matches `subjectPrefix`
with `left()`, so cards read a surface's teachables with a prefix search —
no new index, no migration. `fact` entries are append-only under the
unchanged gate — writing revised advice under the same `teachable:` subject
leaves both facts live, newest first in the card — so a revision supersedes
by recency, never by replacement. An empty slug after the prefix is not a
teachable. The gate path is unchanged: RBAC, classification, redaction,
idempotency, conflict, insert, and read-back all apply, so a refused
teachable is a refused `fact`, nothing more.

Each accepted + verified teachable emits one `note` shaped like the mapped
`teachable.accepted` sample — kind `note`, the writer's surface, summary
`teachable accepted: <slug>`, payload
`{ action: "teachable", memory_id, subject, content_sha256 }` — hash only,
never content bytes. Refused, quarantined, and conflicting writes emit no
teachable event.

## The card route

`GET /.well-known/agent-card.json?surface=<name>` serves one surface's card
as JSON. Missing `surface` → 400 naming the parameter; unknown surface →
400; a surface with no teachables gets a valid card with empty `skills[]`.
Discovery is unauthenticated, same exemption class as `/healthz`: no agent
action sits behind the route, no audit record, nothing emitted.

Card fields (repo-documented A2A v1.0 set — UNVERIFIED pending G1): `id`,
`name`, `description`, `url` (loopback marker), `version`, `capabilities`
(object), `defaultInputModes` / `defaultOutputModes`, `supportedInterfaces[]`,
`skills[]`. One skill entry per live teachable (superseded rows excluded,
newest first): `id` is the accepted memory id, `name` the slug normalised to
the phase-21 `SKILL_NAME_RE` (numeric suffix on fold collision),
`description` the redacted text capped at 1,200 chars, `tags`
`["teachable-moment"]`. `examples` is omitted — no source data exists and
nothing is invented. `skills[]` lists teachables only in v1.3; library
`SKILL.md` entries are a deferred union.

## Anchor coverage

The teachable event is a normal event: server ingest order, `hourDigest`,
hourly anchor, `verifyGraph` hour report cover it with zero anchor-code
changes. The isolated proof (`teachable-anchor.test.ts`) drives a
`teachable:` write on a scratch substrate, shows `hourDigest` covering the
event id, and shows `verifyGraph` reporting the hour `anchored` with the
event inside it — plus a tamper case where one altered event in the hour
fails verify naming the hour. The session → card leg (`agent-card.test.ts`)
shows a session teachable appearing in its surface's card only.

## OPERATOR-GATED live steps (markers only — never executed by agents)

| # | What | Why | Kind | Rollback |
|---|------|-----|------|----------|
| G1 | Fetch the published A2A spec (`https://a2a-protocol.org/latest/specification/`) and diff its Agent Card required fields against the in-repo validator set; record confirmation or correction | The spec URL/shape is UNVERIFIED; the validator must not calcify an assumed set | read-only (network read) | none — read-only |
| G2 | Read a loopback card per surface (`GET /.well-known/agent-card.json?surface=<name>` × 27); decide whether any card is published beyond loopback (none in v1.3) | Any real card publication endpoint is operator-gated | read-only (loopback); write only if exposure is approved (never in this phase by default) | stop serving / restrict |
| G3 | With the funded devnet key: emit a proof teachable into production, let the hourly timer anchor its hour, read the memo back by `tx_sig`, `substrate verify <proof graph>` shows the teachable hour `anchored` | CARD-03/CARD-04 live leg — every teachable covered by the hourly anchor, proven on devnet-backed hours | write (production ledger + devnet + `anchors` row + ledger event) | none needed — one proof hour stands as history |
