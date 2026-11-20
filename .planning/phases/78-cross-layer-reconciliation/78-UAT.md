# Phase 78: Cross-layer reconciliation UAT

Goal: the ledger, the index and the cache agree, and any drift is reported with evidence; repair only via a confirmed plan.

Context: code verify in `VERIFICATION.md` (2026-11-19) is green on the forget pair (2/4 truths verified); the two graph pairs exist but only judge graphs named in `SUBSTRATE_RECONCILE_GRAPHS`, and index-to-ledger drift is report-only by design. The scheduled unit is staged, not installed. The items below close the loop.

## UAT-1: Installed tick reports counts, changes nothing

- Steps: per `infra/vps/README.md`, copy the staged unit pair + drop-in, `systemctl daemon-reload`, `systemctl enable --now substrate-cross-layer-reconcile.timer`. Record ledger note count, index forget markers and cache forget mark before the first tick; run `journalctl -u substrate-cross-layer-reconcile` after.
- Pass: journal shows per-layer counts (ledger forget notes, index forgotten/superseded/absent/in-force, cache state) + coverage; exit 0 on a clean run; all three recorded counts unchanged.
- Fail: tick writes a ledger note, index mark or cache mark; counts missing; exit nonzero on a clean run.

## UAT-2: Pair scheduling decision

- Steps: decide whether `SUBSTRATE_RECONCILE_GRAPHS` gating (default: no graphs judged) and index-to-ledger having no automatic repair satisfy the phase goal; record the decision.
- Pass: a written decision accepting the narrowed scope, or follow-up issues created for default scheduling and/or an index-to-ledger repair.
- Fail: silence — `VERIFICATION.md` stays `human_needed`.

## UAT-3: Live mismatch is reported, repaired only via confirmed plan (operator-approved only)

- Steps: plant one forget whose index row is still in force, let the next tick run, read the journal; then run `substrate reconcile` plan/apply with the plan id as `--confirm`.
- Pass: tick exits 3, journal names the first mismatching key (layer index, reason in-force), tick itself writes nothing; apply touches only planned keys and records `reconcile.applied`.
- Fail: tick writes anything, misses the first key, or repairs without a confirmed plan.

## UAT-4: Cache-index repair gated the same way (optional, if a graph is named)

- Steps: with `SUBSTRATE_RECONCILE_GRAPHS` set to a drifted graph, confirm journal names the first cache-index key/surface; plan via `--cache-index GRAPH_ID`, apply with the plan id as `--confirm`.
- Pass: apply bumps only the two planned generation keys, refuses without `confirm`, refuses on a tampered plan.
- Fail: any other key bumped, or an unconfirmed apply writes anything.
