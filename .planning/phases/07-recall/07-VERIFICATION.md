---
phase: 07-recall
verified: 2026-09-27T22:02:28Z
status: gaps_found
score: 14/19 must-haves verified (14 verified, 5 not verified — owner skip of recall at the 07-02 checkpoint; override recorded, not applied)
covered_files:
  - .env.example
  - .planning/phases/07-recall/07-01-INVENTORY.md
  - .planning/phases/07-recall/07-01-PLAN.md
  - .planning/phases/07-recall/07-01-SUMMARY.md
  - .planning/phases/07-recall/07-02-PLAN.md
  - .planning/phases/07-recall/07-02-SPIKE.md
  - .planning/phases/07-recall/07-02-SUMMARY.md
  - .planning/phases/07-recall/07-03-PLAN.md
  - .planning/phases/07-recall/07-03-SUMMARY.md
  - .planning/phases/07-recall/07-04-PLAN.md
  - .planning/phases/07-recall/07-05-PLAN.md
  - .planning/phases/07-recall/07-06-PLAN.md
  - .planning/phases/07-recall/07-07-PLAN.md
  - .planning/phases/07-recall/07-08-PLAN.md
  - .planning/phases/07-recall/07-BASELINE.md
  - .planning/phases/07-recall/07-CONTEXT.md
  - packages/mcp-server/src/redact.test.ts
  - packages/mcp-server/src/redact.ts
covered_digest: "v1:sha256:dfd822f0d4cc1b8690a355b3b7b02d1bc2acd4a8ef4a62396040b71ae9b75bc8"
covered_files_note: "Computed at HEAD b43b228 with `query verification.fingerprint`. Excluded: ROADMAP.md (a tracking log, modified in the working tree by the orchestrator); 07-RESEARCH-CONTRACTS, 07-VALIDATION and COVERAGE.md (not plan, summary or evidence inputs). 07-04..07-08 PLAN.md are covered because their must-haves are the undelivered recall work folded into the gaps below. The only code Phase 7 changed since agent-substrate-head 4fa90f2 is redact.ts, redact.test.ts and .env.example (git diff --stat)."
behavior_unverified: 0
overrides_applied: 0
owner_skip_overrides_recorded: 5 # on the five gaps below; not applied — see "Why the status is gaps_found"
gaps:
  - truth: "SC1: context_search (MCP) and POST /context/search proxy Agentmemory's POST /agentmemory/search (D-05) with AGENTMEMORY_URL/AGENTMEMORY_SECRET from substrate.env; results carry graph_id, repo and surface, marked untrusted; an outage or missing key returns an empty result with the reason logged"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "07-02-SPIKE.md § Owner report (07-02 Task 2 resume signal); 07-02-SUMMARY.md key-decisions; ROADMAP Phase 7 Owner skip line"
    reason: "Not built. 07-04 (client, tool, route) and 07-05 (live tracer, fail-open instance) did not run. `git grep -nE 'context_search|context/search|agentmemory|AGENTMEMORY|rememberBody' -- packages infra` matches only D-04 comments and test names in redact.ts/redact.test.ts; packages/mcp-server/src/recall does not exist; substrate.env has 0 AGENTMEMORY_* lines."
    artifacts:
      - path: "packages/mcp-server/src/recall/ (client, record, search)"
        issue: "does not exist (07-04 skipped)"
      - path: "packages/mcp-server/src/mcp.ts, server.ts"
        issue: "no context_search tool and no POST /context/search route"
      - path: "/etc/substrate/substrate.env"
        issue: "0 AGENTMEMORY_URL / AGENTMEMORY_SECRET lines (owner did not append them)"
    missing:
      - "07-02 Task 2–3: owner Railway report, the two no-echo env appends, and the live contract spike (livez, 401, /config/flags, /remember → /search format full round trip, latency vs the 2 s deadline, /forget)"
      - "07-04: Agentmemory client with its own 2 s deadline and fail-open reasons, context_search tool and POST /context/search (D-05, D-06, D-08), rememberBody (D-02)"
      - "07-05: guarded restart, the live handoff tracer, and the loopback 127.0.0.1:7419 fail-open runs"
  - truth: "SC2: the substrate forwards already-redacted session.end summaries, handoffs and memory notes to Agentmemory with project=<repo>, agentId=<surface> and the Graph ID; nothing leaves the VPS before redact()"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "07-02-SPIKE.md § Owner report; ROADMAP Phase 7 Owner skip line"
    reason: "The forwarder was never built (07-06 skipped): no forwarder, no /var/lib/substrate/recall cursor, no backfill. Nothing leaves the VPS at all, so the 'before redact()' clause holds only vacuously. Its precondition is delivered: 07-03's D-04 rules are in redact.ts and wired into the write path (truths 16–18), but the forward-time re-redaction in 07-04 rememberBody that 07-03's key link targets does not exist."
    artifacts:
      - path: "packages/mcp-server/src/recall/record.ts (rememberBody)"
        issue: "does not exist; 07-03 key link redact.ts → rememberBody is NOT_WIRED"
      - path: "/var/lib/substrate/recall/cursor.json"
        issue: "does not exist (07-06 skipped)"
    missing:
      - "07-06: async post-write enqueue from Substrate.emit and writeMemory (D-03), forwarded-id cursor, 14-day backfill of backfill_expected=10 records (D-11), outage drop-and-log, run-time redaction fixture proving nothing unredacted reaches Agentmemory"
  - truth: "SC3: the deployment is Agentmemory >= 0.9.29 (D-08) with per-agent isolation (upstream #817), checked before the first write"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "07-02-SPIKE.md § Owner report and § Result (spike_result=fail, spike_result_reason=owner-skip)"
    reason: "Not checked. 07-02 Task 3 did not run: no GET /agentmemory/health, no version gate, no isolation check. The Railway deployment's version and scope are unknown to this record. No boot/first-write gate exists in code (07-06 skipped)."
    artifacts:
      - path: ".planning/phases/07-recall/07-02-SPIKE.md"
        issue: "records spike_result=fail; no version_gate or isolation keys"
    missing:
      - "07-02 Task 3: keyed /agentmemory/health version >= 0.9.29, isolation proof (spike memory by agentId substrate-spike found only under that agentId or *), D-11 single-holder secret check"
      - "07-06: boot and pre-drain version gate that keeps forwarding off below 0.9.29"
  - truth: "SC4: hindsight (Claude Code) and supermemory (Hermes) are retired in favour of context_search, each with a restore route written first"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "07-02-SPIKE.md § Owner report; ROADMAP Phase 7 Owner skip line (07-04..07-08 do not run)"
    reason: "Not done (07-07 skipped). Live: /root/.claude.json mcpServers = greptile,hindsight,linear,notion (hindsight entry identical to the t0 extract); 3 hindsight hook groups in settings.json; Hermes memory.provider=supermemory; no substrate MCP in either agent. settings.json and Hermes config.yaml are byte-identical to the t0 snapshot. No RESTORE.d/07-07.md exists."
    artifacts:
      - path: "/root/.claude.json, /root/.claude/settings.json"
        issue: "hindsight MCP entry and 3 hook groups still present; substrate MCP absent"
      - path: "/root/.hermes/config.yaml"
        issue: "memory.provider=supermemory; no substrate route"
    missing:
      - "07-07: RESTORE.d/07-07.md first; remove hindsight MCP and hooks (data left on disk); register substrate MCP in Claude Code as deny-mutating (D-14); `hermes memory off`; give Hermes a context_search route (D-10)"
  - truth: "Proof: a fact recorded in one agent's session is recalled, with its Graph ID, by a different agent's context_search"
    status: failed
    override: "owner-skip 2026-09-27"
    owner_answer_verbatim: "skip"
    owner_answer_source: "07-02-SPIKE.md § Owner report"
    reason: "Not run (07-08 skipped). There is no context_search to recall through and no 07-PROOF.md."
    artifacts:
      - path: ".planning/phases/07-recall/07-PROOF.md"
        issue: "does not exist"
    missing:
      - "07-08 (D-12): headless Omp session records a decision in graph X; headless claude -p with a session-scoped --mcp-config recalls it with graph X via context_search; phase-end two-sided gates"
---

# Phase 7: Recall Verification Report

**Phase Goal:** Any agent can recall what earlier sessions on any surface learned, through one substrate
tool keyed by Graph ID: the substrate forwards its own already-redacted summaries to Agentmemory and
fronts Agentmemory's search as `context_search`.
**Verified:** 2026-09-27T22:02:28Z (HEAD b43b228)
**Status:** gaps_found
**Re-verification:** No — initial verification

The goal is not achieved. The owner stopped recall at 07-02's Task 2 checkpoint with the resume
signal "skip" (07-02-SPIKE.md § Owner report). As a result there is no Agentmemory configuration, no
`context_search`, no forwarder, no version gate, no retirement of hindsight or supermemory, and no
proof. SC1–SC4 and the Proof are gaps. Each carries `override: owner-skip 2026-09-27`, and none is
marked passed.

What did run holds up. 07-01 recorded a reproducible baseline, an intact rollback area and a live
inventory, and changed nothing live. 07-03 added the eleven D-04 secret classes to `redact()`, pinned
by six run-time fixture tests that I re-ran green. `normalizeEvent` and memory writes call that
function. One caveat matters (N1): the running substrate-mcp process started before the 07-03 commit,
so production emits still use the pre-D-04 rules until the next restart.

## Why the status is gaps_found

I applied the rule the Phase 5 and Phase 6 verifiers used (06-VERIFICATION.md § Why the status is
gaps_found):

1. **The items are not verified.** The phase record declines to claim them. 07-02-SPIKE.md records
   `spike_result=fail` and `spike_result_reason=owner-skip`, and ROADMAP Phase 7 says "SC1–SC4 and
   the Proof are not delivered". The assignment also says not to mark them passed. Unpassed items
   are gaps, and gsd-verifier Step 9 rule 1 turns any gap into `gaps_found`.
2. **The overrides guide excludes this case.** An override counts only once it becomes `PASSED
   (override)`. The guide's "When NOT to Use" list includes "The implementation is simply
   incomplete". Recall has no implementation, not even an alternative one. The owner's only word is
   the checkpoint answer "skip". That accepts the work is not done; it does not rule it done.
3. **No later phase takes the work (Step 9b).** The only later phase is Phase 8 (Hot cache). It
   would *cache* `context_search`, not build it, and the owner skipped Phase 8 too ("Skip Phase 8").
   Nothing can move to the deferred list.

The owner-skip annotations stay on the gap entries and are not in a top-level `overrides:` list.
Step 3b would otherwise fuzzy-match such a list on re-verification and turn the gaps into `PASSED
(override)`.

## Goal Achievement

### Observable Truths

Truths 1–5 come from the ROADMAP contract. Truths 6–19 are the must-haves of the plans that ran:
07-01, 07-02 up to its owner checkpoint, and 07-03. The must-haves of the skipped work are folded
into the five frontmatter gaps under `missing:`. That covers 07-02 Tasks 2–3 (owner report, version
gate, isolation, D-11 secret check, contract spike) and all of 07-04 to 07-08. The forward-time half
of 07-03's third truth depends on 07-04's rememberBody, so it sits under gap 2.

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: `context_search` / `POST /context/search` proxy Agentmemory search; untrusted results; fail-open | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | Owner answer verbatim: "skip" (07-02-SPIKE § Owner report). `git grep` for context_search/context/search/agentmemory/AGENTMEMORY/rememberBody in packages and infra finds only D-04 comments and test names. No `recall/` directory exists. substrate.env has `grep -c '^AGENTMEMORY_'` = 0, mode 600 root. |
| 2 | SC2: forward already-redacted records with project/agentId/Graph ID; nothing leaves before `redact()` | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | There is no forwarder and no /var/lib/substrate/recall. Nothing leaves the VPS, so the redact() clause holds only vacuously. The D-04 precondition is delivered (truths 16–18). |
| 3 | SC3: Agentmemory ≥ 0.9.29 with per-agent isolation, checked before the first write | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | 07-02 Task 3 did not run. 07-02-SPIKE has no version_gate or isolation key, and there was no keyed call to Agentmemory. |
| 4 | SC4: hindsight and supermemory retired in favour of `context_search`, each with a restore route first | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | Live: Claude mcpServers = greptile,hindsight,linear,notion; 3 hindsight hook groups; Hermes `memory.provider` = supermemory; no substrate MCP in either agent. settings.json sha256 843f31c6… and config.yaml 7b1555ff… equal the t0 copies. There is no RESTORE.d/07-07.md. |
| 5 | Proof: a fact recorded by one agent is recalled with its Graph ID by another agent's `context_search` | ✗ NOT VERIFIED — owner-skip 2026-09-27 (override recorded, not applied) | 07-08 did not run, and 07-PROOF.md does not exist. |
| 6 | 07-01: phase order checked (Phase 6 passed, or accepted with a verbatim note; symbols present) | ✓ VERIFIED | 07-BASELINE: `phase6-verification=accepted` plus `phase6-accepted-note:` quoting "Skip Phase 6 anchoring" and "Accept gaps, continue". 06-VERIFICATION `status: gaps_found`, which is consistent with `accepted`. Also `phase6-symbols=present`, and `phase6-cutover-ingested-at=2026-09-27T13:02:16.494Z` equals 06-05-CUTOVER's `cutover_ingested_at`. |
| 7 | 07-01: disk gate ≥ 10 GiB | ✓ VERIFIED | `disk-avail-before=193814814720`. |
| 8 | 07-01: two-sided baseline measured before any Phase 7 edit | ✓ VERIFIED | `agent-substrate-head=4fa90f2…ae24` (the commit just before 11ba60f); pass=634, fail=0, "Ran 634 tests across 36 files"; tsc clean with one `tsc-set: tsc-exit=0` line; dispatcher 149/0. The 07-01 Task 1 verify re-ran all three and reproduced them (07-01-SUMMARY § Verification). |
| 9 | 07-01: /var/lib/substrate/phase7-baseline 0700 root with RESTORE.md, RESTORE.d/07-01.md and a t0 snapshot whose manifest verifies | ✓ VERIFIED | Live `ls -la`: dir and RESTORE.d are drwx------ root; RESTORE.md and RESTORE.d/07-01/02/03.md are 600 root; RESTORE.md names 7 `RESTORE.d/07-0[2-8].md` lines. `sha256sum -c MANIFEST.sha256` in t0-20260927T165601Z: all 7 files OK, each 600 root. |
| 10 | 07-01: live presence recorded as counts and names, never values | ✓ VERIFIED | 07-BASELINE: agentmemory-url/secret-lines 0/0, substrate-token-lines 0, claude-hindsight-mcp=present, claude-hindsight-hooks=3, claude/hermes-substrate-mcp=absent, hermes-memory-provider=supermemory, agentmemory-native=absent, hindsight-data-files=63. My live re-read matches every one (hooks 3; 63 files under /root/.hindsight; 0 hindsight processes). |
| 11 | 07-01: inventory of backfill volume, ingested_at completeness, cap sizing, shape hits and the redact() gap | ✓ VERIFIED | 07-01-INVENTORY: events 3+2+3 = `events_14d_total=8`; memory 0+1+1 = `memory_14d_forwardable=2`; `backfill_expected=10` = 8+2; `events_post_cutover_ingested_at_null=0`; `memory_over_cap=0`; `shape_hits_14d=0`; 11 `redact_gap_class` lines, all unchanged = `redact_gap_unchanged=11`; one `## Gaps` heading. |
| 12 | 07-01 (and the phase as a whole): nothing live changed | ✓ VERIFIED | substrate-mcp ActiveEnterTimestamp is still `Sun 2026-09-27 13:01:42 UTC` (= `substrate-mcp-active-since`), and /healthz is 200. substrate.env has 0 AGENTMEMORY lines; the agent configs equal t0 (truth 4). The only non-.planning diff since 4fa90f2 is .env.example, redact.ts and redact.test.ts. |
| 13 | 07-02: the env-line RESTORE route is written to RESTORE.d/07-02.md (never the index) before the owner edits substrate.env | ✓ VERIFIED | RESTORE.d/07-02.md exists, 600 root, 2664 B, mtime 17:31, before the 21:43 skip record. 07-02-SUMMARY records RESTORE.md sha256 6585ec45… before and after, and I found RESTORE.md's mtime still 16:59. The owner never edited substrate.env (0 lines). |
| 14 | 07-02: verification is presence-only; no value appears in any evidence | ✓ VERIFIED | 07-02-SPIKE holds only `grep -c` counts and `stat` modes. There were no values to leak (0 lines), and no keyed probe ran. |
| 15 | 07-02: no silent fallback — an owner skip stops the plan with spike_result=fail and a reason; no substitute backend | ✓ VERIFIED | 07-02-SPIKE: `spike_result=fail`, `spike_result_reason=owner-skip`. No recall code or alternate backend exists in packages/ (truth 1 grep). No `(07-04..08)` commit exists (`git log` since 4fa90f2 shows only 07-01/02/03 commits). |
| 16 | 07-03 (D-04): `redact()` removes AKIA, AIza, xoxb-, npm_, glpat-, dop_v1_, sk-proj-, pk-/rk-, `<private>…</private>` and case-insensitive api_key/apiKey/api-key | ✓ VERIFIED | redact.ts:21 puts the `<private>` rule first in RULES, and :36 is the case-insensitive api-key assignment (keeps the key). Lines 53–67 cover AKIA, AIza, xoxb-, npm_, glpat-, dop_v1_, sk-proj- and pk\|rk. `bun test redact.test.ts -t 'D-04'`: 6 pass / 0 fail (run by me). RED 3e0f515 → GREEN cc124b5, both with `Refs SPE-3576`. |
| 17 | 07-03: each class pinned by run-time fixtures; no literal token shape committed; near-miss controls unchanged; second pass a no-op | ✓ VERIFIED | redact.test.ts:260 `describe("redact D-04 classes")` holds the 5 named tests plus "D-04 redactValue reaches the new rules through its string path" (:261–306). A regex scan of redact.test.ts for the seven prefixed D-04 shapes finds 0 matches. "leaves near-miss shapes alone" and "redaction is idempotent" are in the 6 passes. |
| 18 | 07-03: `redact()` is the write-path redactor, so the rules cover what is stored (write-path half; the forward-time half is gap 2) | ✓ VERIFIED | event.ts:100–101 `summary: redact(input.summary)…`, `payload: redactValue(input.payload ?? {})` inside normalizeEvent. index-store.ts:257 inserts `redact(entry.text)` into memory_entries. redactValue's string path is tested (truth 17). See N1: the running process has not loaded these rules yet. |
| 19 | 07-03: existing rules, redactValue and SKILL_RULES unchanged in behaviour; root suite and tsc two-sided green with more passes than 634 | ✓ VERIFIED | `git diff 4fa90f2 HEAD -- redact.ts` removes exactly one line, the docblock comment " * Railway, bearer tokens, JWTs and passworded connection URLs." No rule changed. My run of `bun test redact.test.ts event.test.ts` gave 64 pass / 0 fail / 2 files (it includes Phase 6's pre-cutover fixture recompute). The root suite 640/0/36 > 634 and tsc `tsc-exit=0` come from 07-03-SUMMARY; I did not re-run them. After cc124b5 only .planning files and .env.example (comments and empty keys) changed. |

**Score:** 14/19 truths verified (0 present, behavior-unverified; 0 overrides applied; 5 owner-skip gaps)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `.planning/phases/07-recall/07-BASELINE.md` | `agent-substrate-tsc-set:` and the machine-readable keys | ✓ VERIFIED | Every key once; tsc-set line present |
| `.planning/phases/07-recall/07-01-INVENTORY.md` | `backfill_expected=` | ✓ VERIFIED | `backfill_expected=10` |
| `/var/lib/substrate/phase7-baseline/{RESTORE.md, RESTORE.d/07-01..03.md, t0-…}` | rollback area | ✓ VERIFIED | 700/600 root; the manifest verifies |
| `.env.example` | Recall block with empty AGENTMEMORY_URL= / AGENTMEMORY_SECRET= | ✓ VERIFIED | +5 lines, no values; inert |
| `.planning/phases/07-recall/07-02-SPIKE.md` | owner report, spike_result | ⚠️ PARTIAL (owner-skip) | Owner report and `spike_result=fail` present; the version, isolation and contract keys are absent (gaps 1 and 3) |
| `packages/mcp-server/src/redact.ts` | D-04 rules; contains `dop_v1_` | ✓ VERIFIED | 286 lines; :21, :36, :53–67 |
| `packages/mcp-server/src/redact.test.ts` | "D-04 redacts every class agentmemory's /remember does not filter" | ✓ VERIFIED | :261 |
| recall client/record/search modules, context_search tool and route, forwarder, cursor.json, RESTORE.d/07-04..08.md, 07-PROOF.md | the recall integration | ✗ MISSING (owner-skip) | gaps 1–5 |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| 07-BASELINE.md | later 07-NN gates | `agent-substrate-pass=`, tsc-set, failing-id lines | ✓ WIRED | 07-03's gate read it (640 > 634, no set diff) |
| 07-01-INVENTORY.md | 07-03 fixture tests | `redact_gap_class:` lines | ✓ WIRED | The 11 classes listed are the 11 fixtures in "D-04 redacts every class…" |
| 07-01-INVENTORY.md | 07-06 backfill check | `backfill_expected` | ✗ NOT_WIRED (owner-skip) | 07-06 did not run |
| redact.ts | event.ts normalizeEvent / index-store.ts memory insert | `redact(` / `redactValue(` | ✓ WIRED | event.ts:9, :100–101; index-store.ts:21, :257 |
| redact.ts | recall/record.ts rememberBody (07-04) | `redact(` at forward time | ✗ NOT_WIRED (owner-skip) | The target does not exist (gap 2) |
| substrate.env AGENTMEMORY_* | substrate-mcp config | EnvironmentFile + loadConfig | ✗ NOT_WIRED (owner-skip) | 0 lines; no config reader |
| Claude Code / Hermes | substrate MCP `context_search` | `claude mcp add` / Hermes route | ✗ NOT_WIRED (owner-skip) | Neither is registered (gap 4) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| stored event summary/payload | D-04-redacted text | normalizeEvent → redact()/redactValue → IngestChain → Greptime | Yes in code (tests), but not yet in the running process (N1) | ⚠️ FLOWING on next restart |
| memory_entries.body | D-04-redacted text | writeMemory → `redact(entry.text)` → Postgres | Same as above | ⚠️ FLOWING on next restart |
| context_search results | `{text, graph_id, repo, surface, ts, score}` | — | No source | ✗ DISCONNECTED (owner-skip, gap 1) |
| Agentmemory memories | forwarded records | — | No writer | ✗ DISCONNECTED (owner-skip, gap 2) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| D-04 tests | `SUBSTRATE_DISABLED=1 bun test redact.test.ts -t 'D-04'` | 6 pass / 0 fail / 1 file | ✓ PASS |
| Redaction plus Phase 6 event/fixture regression | `SUBSTRATE_DISABLED=1 bun test redact.test.ts event.test.ts` | 64 pass / 0 fail / 2 files | ✓ PASS |
| Only additive change to redact.ts | `git diff 4fa90f2 HEAD -- redact.ts \| grep '^-[^-]'` | one docblock comment line | ✓ PASS |
| Phase 7 code scope | `git diff --stat 4fa90f2 HEAD -- packages infra .env.example` | 3 files, +104 −1 | ✓ PASS |
| Service state | `systemctl show -p ActiveEnterTimestamp`; `/healthz`; `systemctl cat` | 13:01:42 UTC; 200; `ExecStart=bun packages/mcp-server/src/index.ts`, `Restart=always`, no watch flag | ✓ PASS (see N1) |
| Rollback area | `sudo ls -la`; `sha256sum -c MANIFEST.sha256`; grep for the head and `(07-03\)` in RESTORE.d/07-03.md | 700/600 root; 7/7 OK; 1 and 1 | ✓ PASS |
| Recall absent | `git grep` context_search/agentmemory/AGENTMEMORY/rememberBody; `ls recall/`; `sudo grep -c '^AGENTMEMORY_'`; `ls /var/lib/substrate/recall` | only D-04 comments and test names; absent; 0; absent | ✓ PASS (confirms gaps 1–3) |
| Agents unchanged | sha256 of settings.json and Hermes config.yaml vs t0; hindsight entry vs t0 extract; jq hook count; yaml provider | equal; equal; 3; supermemory | ✓ PASS (confirms gap 4) |

Every live check only read state. I made no emit, write, restart or Agentmemory call. I did not re-run
the root suite, tsc or pytest; those numbers come from 07-01's and 07-03's gates.

### Probe Execution

No Phase 7 plan or summary declares a `probe-*.sh`, and none exists. Step 7c: no probes.

### Requirements Coverage

Every plan has `requirements: []`, and there is no .planning/REQUIREMENTS.md. The ROADMAP success
criteria (as amended by 07-CONTEXT D-05 and D-08) are the contract. The owner decisions D-01–D-14 map
onto them: D-04 is delivered (truths 16–19), and D-01–D-03 and D-05–D-14 fall under gaps 1–5. There
are no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/"not yet implemented" | — | No debt markers in redact.ts or redact.test.ts. The only hit is the pre-existing `PLACEHOLDER_PREFIXES` identifier (redact.ts:199, skill-content placeholder words, D-18), which is code, not a marker |
| .env.example | Recall block | empty `AGENTMEMORY_URL=` / `AGENTMEMORY_SECRET=` | ℹ️ Info | Documentation of the env contract, and inert: nothing reads them (07-02-SUMMARY § State after the stop) |

### Human Verification Required

None. The five open items are gaps, not human checks. They carry the owner's recorded skip, so the
next step is the orchestrator's decision (see Gaps Summary), not a test.

### Notes (non-blocking)

- **N1 — The D-04 rules are not loaded in production yet (⚠️ Warning).** substrate-mcp has been
  active since 2026-09-27 13:01:42 UTC (the 06-05 restart). cc124b5 landed at 17:23:43 UTC, and
  `ExecStart` runs `bun packages/mcp-server/src/index.ts` with no watch mode. The running process
  therefore still redacts with the pre-D-04 RULES. Until substrate-mcp restarts, an AKIA, AIza,
  xoxb-, npm_, glpat-, dop_v1_, sk-proj-, pk-/rk-, `<private>` or lower-case `api_key:` value in an
  event summary, payload or memory note would be stored in append-only Greptime or Postgres
  unredacted. The window's baseline measured `shape_hits_14d=0`. 07-03 planned no restart and left it
  to 07-05, which is now skipped, so no restart is scheduled. `Restart=always` loads the working tree
  on any restart, and RESTORE.d/07-03.md holds the code route. ROADMAP's "redact() gains the D-04
  secret classes on every emit" is true of the code, not yet of the running service. A guarded
  restart (working tree under packages/ and infra/ clean, /healthz 200 within 60 s, else run the code
  route) would close this. It is the orchestrator's call; it is outside this read-only verification.
- **N2 — Inert leftovers (ℹ️ Info).** The .env.example Recall block and RESTORE.d/07-02.md (with its
  env-line, Railway and spike-forget routes) stay in place. Without values they do nothing, and a
  later re-run of 07-02 from Task 2 reuses them (07-02-SUMMARY).
- **N3 — The inventory will go stale (ℹ️ Info).** `backfill_expected=10` covers the window
  2026-09-13 to 2026-09-27. A later revival must re-measure it, and 07-06 was designed to count over
  its own window anyway.

### Gaps Summary

All five gaps have one root cause. The owner answered the 07-02 Task 2 checkpoint (Agentmemory
Railway report, upgrade to ≥ 0.9.29, the two env appends) with "skip" on 2026-09-27. Without
AGENTMEMORY_URL and AGENTMEMORY_SECRET there is no backend, and 07-02 has no substitute by design.
So Task 3 (version gate, isolation, contract spike) did not run, and 07-04 through 07-08 did not
start. The phase record agrees everywhere. 07-02-SPIKE.md records `spike_result=fail` for reason
`owner-skip`, and ROADMAP Phase 7 records the skip and lists 07-01 and 07-03 as the only delivered
work.

The orchestrator or owner can close the gaps in one of two ways:

- **Proceed without recall.** Record Phase 7 as accepted with the owner's verbatim "skip", citing
  this report. This is the same route Phases 5 and 6 took (`phaseN-verification=accepted` with a
  verbatim note). Phase 8, the only phase that depends on Phase 7, is also skipped by the owner. Before
  or alongside that, decide on N1: restart substrate-mcp under the guarded procedure so the D-04 rules
  protect production writes.
- **Build recall later.** Re-run 07-02 from Task 2: the owner does the Railway report, upgrades to ≥
  0.9.29 and appends both env lines. Then run 07-02 Task 3 and 07-04 through 07-08 as planned, after
  re-measuring 07-01's inventory.

No code change inside Phase 7 can close these gaps without the owner's Agentmemory inputs.

---

_Verified: 2026-09-27T22:02:28Z_
_Verifier: Claude (gsd-verifier)_
