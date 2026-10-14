# 31-SPIKE.md — Lane A runtime spike record

**Runner:** `scripts/host-spike.ts` (`--check` = step 0 + guards, CI-safe).
**Status:** step 0 asserted read-only on 2026-10-10; G1/G2/G3 OPERATOR-GATED (runner exits 3 at G1 by design).

## Step 1 — read-only facts (asserted 2026-10-10, `bun scripts/host-spike.ts --check`, exit 0)

| Fact | RESEARCH baseline | Observed | Verdict |
|---|---|---|---|
| `/dev/kvm` | absent | absent | match |
| cpu `vmx`/`svm` flags | none | none | match |
| `127.0.0.1:6420` | served by rivet engine | served | match |
| `127.0.0.1:7411` | free | free | match |
| disk avail `/` | `>= 10737418240` | 128308633600 | match |
| `substrate-sandbox:0.1` | absent | absent | match |
| `/var/lib/substrate/agentos` | 318 M note | 332755597 bytes (~317 M) | match |

No drift: the gated tail may proceed only with operator approval per step.

## G1 — dependency footprint (OPERATOR-GATED, not run)

| Field | Value |
|---|---|
| npm tree bytes (precedent ~2.2 GB) | UNRECORDED |
| npm ci wall time | UNRECORDED |
| agentos import resolves | UNRECORDED |

## G2 — engine share (OPERATOR-GATED, not run)

Decision rule (D31-04): connect to the existing loopback engine first; only if
the shared engine refuses the host's actors does the plan fall back to a second
loopback engine on a free port. Either way the engine stays on loopback and the
other project's container keeps running untouched.

| Field | Value |
|---|---|
| shared engine serves the host actor | UNRECORDED |
| refusal text (when refused) | — |
| fallback engine result | NOT NEEDED unless shared refuses |
| engine container still healthy | UNRECORDED |
| unit engine env fixed by this outcome | UNVERIFIED (31-03 defaults to share-mode constants marked UNVERIFIED) |

## G3 — no-KVM boot (OPERATOR-GATED, not run)

Decision rule (D31-06): the claim "agentos needs no KVM" is September's, not
main's. The verdict defaults to UNVERIFIED. A failed boot is a gap, never a
pass; the packaging plans land regardless (they are KVM-independent).

| Field | Value |
|---|---|
| boot verdict | UNVERIFIED |
| exact demand text (when gap) | — |
| dispose-hook execution | UNRECORDED |
| fresh-vs-stale note | UNRECORDED |

## Cleanup verification (runs with the gated tail)

- spike VM disposed, session unloaded, scratch dir removed;
- `gcs-rivet-rivet-engine-1` still healthy and 7411 still free.
