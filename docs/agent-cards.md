# Agent cards and teachable moments

A teachable moment is a governed `fact` whose subject carries the tag as the
prefix `teachable:` (e.g. `teachable:retry-budget`). No new memory kind and no
tags field: the subject is the identity `lww`/`versioned` resolve on, so
teachables collide sanely per topic, and the card reader finds them with a
`subjectPrefix` search — no new index, no migration. The gate path is
unchanged; a refused teachable is a refused fact.

Each surface's card lives at `GET /.well-known/agent-card.json?surface=<name>`
(loopback, unauthenticated A2A discovery like `/healthz`, no audit record).
The card is A2A v1.0 (`name`, `description`, `url`, `version`,
`capabilities`, `defaultInputModes`/`defaultOutputModes`, `skills[]`) with one
skill entry per live teachable: `{ id: <memory id>, name: <slug folded to the
skill-name rule>, description: <redacted text, capped at 1200 chars>,
tags: ["teachable"] }`. Missing or unknown `surface` is a 400, never a
default — a card is per surface. Superseded teachables do not appear.

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
