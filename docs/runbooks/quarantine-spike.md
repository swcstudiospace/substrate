# Runbook — a quarantine spike

| | |
| --- | --- |
| Symptom | `/slo` shows `quarantine.rate` breached, or the `memory_pending` queue grows, or `memory_write` answers `quarantined` / `denied` to a surface that used to land writes |
| Scope | The memory governance gate (`memory-write.ts`), its tables `memory_quarantine` and `memory_reviews`, the claim-side quarantine counter |
| Blast radius | Reads are unaffected: a quarantined or parked write never reaches a brief or a search. The cost is the memory that did not land |
| Untouched | `memory_entries` in force, the ledger chain, leases |

Two different things are called "quarantine" in this repo. Tell them apart first.

| Where it shows | What it counts |
| --- | --- |
| `/metrics` `substrate.quarantine.total` (attributes `surface`, `graph_id`, `reason`) and `/slo` `quarantine.rate` (`substrate.quarantine.total / substrate.lease.claims ≤ 1 %`, `SUBSTRATE_SLO_QUARANTINE`, `SUBSTRATE_SLO_MIN_SAMPLES` 20) | **Claim-side**: nodes withdrawn from dispatch during `graph_claim` (`claimed` samples with a `quarantineReason`, `observe.ts`). A spike here is a dispatch problem, not a memory one |
| `memory_pending` (MCP), the `memory.write quarantined: quarantine.<reason>` and `memory.write denied: rbac.*` `warning` events per writer surface in the ledger, and the sweeper's `quarantine-unresolved` count | **Memory-side**: writes the governance gate parked (`memory_quarantine`) or sent for review (`memory_reviews`), or refused outright (`denied`, nothing stored) |

The rest of this runbook is the memory side. For the claim side, read the
`reason` attribute on the counter and follow the dispatcher's own notes.

## Triage by writer and reason

Every finished memory write leaves one ledger event on the writer's surface
(`Substrate.auditMemoryWrite`): `payload.outcome` one of `accepted | conflict |
quarantined | denied`, `payload.reason` such as `quarantine.secret`,
`quarantine.pii`, `quarantine.speculative`, `rbac.no-grant`, `review.required`.
Quarantined and denied writes are `kind: warning`; a parked proposal
(`review.required`) is a `conflict`, so it arrives as a `note` — run the query
below once per kind. The body is never in the event. From the operator session:

```sh
# the last hour of refusals, grouped by writer and reason
curl -s "http://127.0.0.1:7410/events/query" -H "authorization: Bearer $SUBSTRATE_TOKEN_SUBSTRATE" \
  -H 'content-type: application/json' \
  -d '{"kind":"warning","since":"<ISO one hour ago>","limit":500,"include_payload":true}' \
  | jq -r '.events[] | select(.summary|startswith("memory.write")) | "\(.surface)\t\(.payload.reason)"' | sort | uniq -c | sort -rn
```

And the queue itself, with a reviewer token so bodies are visible (they are what
you need to classify; a `secret` row holds the *redacted* body only):

```
memory_pending { limit: 100, review_token: <one of SUBSTRATE_MEMORY_REVIEW_TOKENS> }
```

Read the three columns the queue gives you — `writer`, `reason`, `scope` — and
the `detail` on quarantined rows. Spikes fall into four shapes:

| Shape | Looks like | Cause |
| --- | --- | --- |
| **One writer, `rbac.no-grant`** | `denied` from a single surface, same scope class and kind every time | A new surface, a renamed scope, or a token that maps to a surface the default grants do not cover. Nothing is stored for a denial |
| **One writer, `quarantine.secret` / `quarantine.pii`** | Same `detail` repeating (`looks like a token`, `email address`) | A collector or hook is pasting a payload field, a URL with credentials, or an address into `text`. The redactor caught it; the writer is wrong |
| **One writer, `quarantine.speculative`** | `kind=decision` or `fact` with hedged text | An agent recording plans as facts. Point it at `kind=todo` / `kind=handoff` |
| **Many writers, `review.required`** | Proposals piling up at `global`, `person:` or `human-confirmed` trust | Nobody is reviewing, or `SUBSTRATE_MEMORY_REVIEW_TOKENS` is unset so every review path is closed and the queue just fills |

The sweeper's daily report (`substrate index sweep`, or the `index.sweep` note
on surface `substrate`) carries `quarantine-unresolved` and `reviews-decided`
counts; a `quarantine-unresolved` number that climbs day over day is this
runbook's trigger even when no SLO moved.

## Fix: the grant (`rbac.no-grant`)

Grants are default-deny: surface × scope class × kind. Widen with
`SUBSTRATE_MEMORY_GRANTS`, a JSON array appended to the defaults (there is no
variable that narrows them). One grant, named so the ledger can say which rule
allowed a write:

```json
[{ "name": "muse-repo-facts", "surfaces": ["muse"], "scopes": ["repo"], "kinds": ["fact", "warning"] }]
```

Set it in the server's environment file (names only in this repo), restart
`substrate-mcp` through `infra/vps/deploy-release.sh` or the documented restart,
and confirm with one `memory_write` from that surface: `outcome: accepted`,
`grant: "muse-repo-facts"` in the reply. A grant naming `unknown` is for a local
run without tokens, never production. Scope classes are `graph`, `repo`,
`global`, `agent`, `person`; `global`, `person:` and `human-confirmed` trust
also need a reviewer, so a grant alone does not clear those.

## Fix: the writer (`quarantine.*`)

Do not loosen the classifier. A `secret` quarantine is final — the remedy in the
reply says so: the writer re-submits describing *where* the credential lives.
`pii` belongs at `person:<name>` scope with a reviewer token, or not at all.
`speculative` is re-submitted as `todo` / `handoff`, or as the original kind
once it is settled. Find the writer from the ledger grouping above and fix the
collector or hook that composes `text`; `docs/memory-governance.md` "Quarantine"
has the classifier's rules.

## Review and release (`review.required`, reviewable quarantine)

`SUBSTRATE_MEMORY_REVIEW_TOKENS` is a comma-separated list in the server's
environment; with it unset, nothing is ever released. A reviewer releases a
parked write by **re-submitting the same content** with `review_token`: the gate
re-decides it with reviewer authority, the entry lands, and every pending
proposal with that content hash (and the same `ttl`) is marked `approved` and
pointed at the entry (`releaseReviews`). The token is never stored or echoed.

- The resubmission must ask for what the proposal asked for — the same `ttl`,
  and `trust: human-confirmed` if that is what was proposed — or the proposal
  stays pending beside a new entry.
- A quarantined `pii` row is released the same way at `person:` scope; a
  `secret` row cannot be released by anyone.
- There is no explicit "reject" API. A proposal nobody installs stays pending
  (never swept); a quarantined row whose content never lands stays, counted as
  `quarantine-unresolved`, never swept.

## When the sweeper removes rows

`index-sweep.ts` (daily `substrate-index-sweep.timer`, dry-run unless
`SUBSTRATE_INDEX_SWEEP=apply` is set on the unit, and `--apply` on the CLI
needs that env too) removes, after 30 days each:

- `memory_reviews` rows in a decided state (`approved`) — the audit trail of a
  review, judged on `decided`;
- `memory_quarantine` rows whose `entry_hash` later appeared in `memory_entries`
  — the reviewer re-submitted them, so the parked copy is redundant.

Pending reviews and unresolved quarantine are only ever counted. Apply is an
operator step: take the Railway volume snapshot first, run `substrate index
sweep` for the dry-run report, then `SUBSTRATE_INDEX_SWEEP=apply substrate
index sweep --apply --json` once, and keep the JSON with the evidence row.

## Rollback

- **A grant was too wide.** Remove it from `SUBSTRATE_MEMORY_GRANTS` and restart;
  entries it let through stay in force until superseded or retired by a
  reviewer's `versioned` write. The ledger's `grant` payload names every write
  the rule allowed.
- **A release was wrong.** Supersede it: a reviewer writes the correction with
  the same `subject` under the `versioned` strategy, which retires the released
  entry (`superseded_by`) in the same transaction. Nothing is deleted.
- **The sweeper applied on the wrong day.** Deleted review and quarantine rows
  are gone; restore the volume snapshot taken before `apply`, or accept the loss
  of 30-day-old audit rows (no entry in force was touched). Set the unit back to
  `SUBSTRATE_INDEX_SWEEP=dry-run`.

## Evidence

| Date (UTC) | Trigger (`/slo`, queue size, sweep count) | Shape | Writer(s) | Fix | Confirmation |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

One row per spike. Reasons and surfaces only — never a body, a token or a grant
value copied from the host.
