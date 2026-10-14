---
phase: "16"
slug: "production-parity-and-rehearsal-harness"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-08"
---

# Phase 16 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| parent process env → scratch server env | production credentials cross here if the allowlist leaks | production tokens, store URLs (high) |
| builder → tracked repo files | secret literals cross here if spelling trips no scanner | credential-shaped literals (high) |
| check → operator checkout .git | shared gitdir; a lock rewrite corrupts every worktree | git index/refs (integrity) |
| check → production /healthz | live read; bearer handling must not leak | caller bearer token (medium) |
| harness → docker daemon | container argv/env; secret must travel by name only | scratch Postgres password, ledger users line |
| down → host processes | kill verified own pid only | signals (availability of production unit) |
| smoke → scratch server | bearer on loopback; reply may carry lease capability | scratch bearer, claim replies |
| runbook → operator console | SQL and systemctl steps run by a human with production access | production procedures |
| docs → future executors | wrong contract text misdirects later proofs | contract text |
| proof → production port 7410 | coexistence; any dial there is a live touch | none permitted |
| agent → operator console | counts cross here by human report | production `rh-` tag counts (read-only) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-16-01 | Information disclosure | buildRehearsalEnv allowlist | high | mitigate | `packages/mcp-server/src/rehearsal-env.ts:134-163` starts from an empty record and copies only `PATH`, `HOME`, `BUN_*`; `assertLoopback` (`:74-85`) runs on both store URLs in `scratchStoreRecords` (`:115-127`); sentinel leak test `rehearsal-env.test.ts:175-195` asserts no parent value reaches the built env | closed |
| T-16-02 | Information disclosure | tracked files (CREDENTIAL/TOKEN_LITERAL) | high | mitigate | computed `LEDGER_KEYS` (`rehearsal-env.ts:23-28`), ledger keys written only as `out[LEDGER_KEYS.*]`; test secrets from `randomBytes` (`rehearsal-env.test.ts:52-60`); `store-lock.test.ts` + `rehearsal-env.test.ts` re-run at audit: 32 pass / 0 fail | closed |
| T-16-03 | Elevation of privilege | operator token mapping | medium | mitigate | `assertOperatorAllowed` (`rehearsal-env.ts:91-101`) enforces operator ⊆ surfaces and refuses `isSwarmSurface`; tests `rehearsal-env.test.ts:153-162` (swarm refused) and `:84`, `:120` (`configWarnings` empty) | closed |
| T-16-04 | Tampering | git probes in operator checkout | high | mitigate | every git call goes through `gitWork` (`scripts/parity-check.ts:207-210`) prefixed `--no-optional-locks`; only verbs used: `log -g`, `status`, `ls-remote`, `cat-file -e`, `diff` (`:336-361`); no fetch/pull/checkout; `cat-file` presence gate precedes `diff` (`:358-361`) | closed |
| T-16-05 | Information disclosure | healthz bearer + output | medium | mitigate | token read from caller `process.env.SUBSTRATE_TOKEN` only and sent as header (`parity-check.ts:237-241`); never written to stdout/stderr; output lines `:409-421` print PIDs, states, commits, healthz status only; `SYSTEMCTL_PROPS` (`:184-185`) excludes `Environment` | closed |
| T-16-06 | Denial of service | unit file edit | medium | mitigate | commit `cf6b108` adds 3 lines only (comment + `ConditionPathExists`); `StartLimitIntervalSec=0` (line 9) and `StateDirectory=substrate`/`StateDirectoryMode=0700` (lines 29-30) unchanged; `systemd-analyze verify infra/vps/substrate-mcp.service` exit 0 at audit; install is an operator-only runbook step | closed |
| T-16-07 | Denial of service (production) | down pid verification | high | mitigate | `mayStop` (`scripts/rehearsal.ts:157-170`) checks pid, start time, entry point, cwd, non-`system.slice` cgroup, no production port (`PRODUCTION_PORTS` 7410/7411/6420, `:45`); `runDown` re-verifies before SIGKILL (`:736-745`); all `process.kill` calls use a positive pid, never a group; no systemctl verb in the harness | closed |
| T-16-08 | Tampering (production stores) | store URLs + smoke guard | high | mitigate | store host ports parsed only from the harness's own `docker port` (`rehearsal.ts:607-613`); store URLs hard-code `127.0.0.1` and pass `assertLoopback`; `refuseSmokeUrl` (`:791-801`) refuses `:7410`/non-loopback before any request (`runSmoke` `:909-910`); `--pull never`, `--tmpfs` data paths, `127.0.0.1::` publishes (`:533-572`) | closed |
| T-16-09 | Information disclosure | argv/logs/output | high | mitigate | secrets reach docker as `-e POSTGRES_PASSWORD` / `-e RH_GT_USERS` names with values in the spawn env (`rehearsal.ts:543-553`, `:576-588`); ledger users file written in-container under `umask 077` (`:586`); run dir/tokens dir `0o700` (`:506-518`), files via `writeMode` `0o600` (`:364-371`, `:521`, `:685-697`); stdout prints hosts/ports/commit/dirty/images (`:700-703`) and claim scalars only (`:955-959`) | closed |
| T-16-10 | Denial of service | container cleanup scope | medium | mitigate | `removeLabelledContainers` (`rehearsal.ts:348-358`) filters strictly on `label=substrate.rehearsal=<name>`; containers created with that label (`:537-538`, `:568-569`); no name-prefix match | closed |
| T-16-11 | Information disclosure | docs values | medium | mitigate | `docs/rehearsal.md` and `docs/runbooks/production-parity.md` hold no connection strings, `KEY=value` pairs or `RAILWAY` mentions (case-insensitive grep at audit: 0 hits); `store-lock.test.ts` green at audit | closed |
| T-16-12 | Denial of service (production) | runbook procedures | medium | mitigate | `production-parity.md`: stray retirement "Operator only" (`:64-78`), install "Operator only, at the next approved restart" (`:150-151`), both rollbacks "operator only" with never-start-from-session warning (`:166-172`, `:77-78`), agent/operator boundary list "Who does what" (`:209-225`) | closed |
| T-16-13 | Tampering (production) | proof targeting | high | mitigate | smoke 7410/non-loopback refusal (T-16-08); smoke reads only own `consumer.env` (`rehearsal.ts:903-910`); server spawned with `--no-env-file` (`:173-175`) and allowlisted env (T-16-01); runbook proof record (`production-parity.md:112-143`) shows twin on `127.0.0.1:17410`, all peers loopback, no `7410` | closed |
| T-16-14 | Repudiation | evidence chain | low | accept | run tag `rh-p16-proof-mv00v314`, dated readings, actor attribution and operator-reported `rh-%` counts recorded in `production-parity.md:114-143`, `:202-207`; see Accepted Risks Log AR-16-01 | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

### Notes (non-blocking)

- `killOwn` (`rehearsal.ts:429-447`) signals `server.pid` without `mayStop`; it is reached only on the `up` failure path for the child the same process just spawned via `Bun.spawn` (`:651`, `:660`), so the target is the harness's own child, within the T-16-07 "own pid only" contract. Residual pid-reuse window is the few seconds between spawn and failure.
- `refuseSmokeUrl` compares `url.hostname` against a table holding `::1` unbracketed; an IPv6 `[::1]` twin URL is therefore refused (fails closed). The harness always writes `127.0.0.1`, so no impact.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-16-01 | T-16-14 | Raw production row counts move with live traffic, so they cannot prove a run added nothing; tag absence (`rh-%` = 0 in Greptime `agent_events` and Postgres `graph_index`/`graph_nodes`/`graph_steps`) plus isolation by construction is the proof per 16-CONTEXT. Counts are operator-reported, not re-queried by agents; the runbook records tag, timestamps and actor. Low severity, below the `high` block threshold. | plan-time disposition (16-05-PLAN threat register, accept) | 2026-10-08 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-08 | 14 | 14 | 0 | Execute16.SecurePhase16 (gsd-secure-phase verify:post, State B, ASVS L1 short-circuit) |

Audit method: State B (no prior SECURITY.md); register built from the five `16-0*-PLAN.md` `<threat_model>` blocks (no SUMMARY `## Threat Flags` sections; SUMMARY "Threat Disposition" sections cross-checked). Static verification of each mitigation against the implementation and docs, plus read-only checks: `bun test packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/rehearsal-env.test.ts` (32 pass / 0 fail), `bun test scripts/rehearsal.test.ts scripts/parity-check.test.ts` (55 pass / 0 fail), `systemd-analyze verify infra/vps/substrate-mcp.service` (exit 0). `threats_open: 0`, register authored at plan time, ASVS level 1 → workflow short-circuit to Step 6; no auditor subagent spawned. Non-interactive run: no user gate was reached (no open threats).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-08
