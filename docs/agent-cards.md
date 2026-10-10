# Agent cards and teachable moments

A teachable moment is a governed `fact` whose subject carries the tag as the
prefix `teachable:` (e.g. `teachable:retry-budget`). Facts append. Writing the
same subject again stores another memory and another skill; it does not
replace the earlier lesson. The prefix is how the card finds them
(`subjectPrefix`), not a conflict key that keeps one current lesson. No new
memory kind and no tags field, no new index, no migration. The gate path is
unchanged; a refused teachable is a refused fact.

Each surface's card lives at `GET /.well-known/agent-card.json?surface=<name>`
(loopback). The GET is served with no bearer even when surface tokens are
configured; authoring routes stay closed. It writes no audit record.
The card is A2A v1.0 (`name`, `description`, `url`, `version`,
`capabilities`, `defaultInputModes`/`defaultOutputModes`, `skills[]`).
`supportedInterfaces` is a non-empty array of objects
`{ url, protocolBinding, protocolVersion }`, not a list of protocol names.
One skill entry per live teachable: `{ id: <memory id>, name: <slug folded to the
skill-name rule>, description: <redacted text, capped at 1200 chars>,
tags: ["teachable"] }`. A teachable past its reverify window keeps the skill
and prefixes the description with `Needs reverification before use.`
Missing or unknown `surface` is a 400, never a default — a card is per
surface. Superseded teachables do not appear.

Anchor coverage falls out of the emit: an accepted + verified teachable writes
one `note` shaped like the `teachable.accepted` vocabulary sample
(`teachable accepted: <slug>`, payload `{ action, memory_id, subject,
content_sha256 }` — id and content hash, never content). A normal event in an
ingest hour, digested whole and reported `anchored`/`pending`/… by the hour
report with zero anchor-code changes.

## Operator window: the live anchored hour (CARD-04, not agent work)

Agents prove everything up to the anchor on scratch ledgers with fake RPC and
never run devnet transactions. The remaining leg is an operator run: with a
funded devnet key (`SOLANA_*` env names only — never values), anchor the hour
holding the teachable and confirm `substrate verify` reports that hour
`anchored` with the teachable's event inside it.
