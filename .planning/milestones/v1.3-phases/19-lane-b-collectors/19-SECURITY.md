---
phase: "19"
slug: "lane-b-collectors"
status: blocked
# Severity-filtered blocking gate (block_on: high). threats_open counts OPEN threats at or above high.
threats_open: 1
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-10"
audited: "2026-11-12"
audited_against: "reconcile/main-2026-11-11 @ 6d0adafd"
---

> Recovered 2026-10-29 from commit 76a4b2c3. The original register was written 2026-10-11 to 2026-10-12 against an out-of-tree worktree (`/root/src/worktrees/agent-substrate-v13-autonomous`) and was not valid for main.
> This revision (2026-11-12) re-verifies every threat against the current checkout. The earlier "SECURED, 18/20 closed" verdict is withdrawn: it rested on line references and mechanisms (installed-hook guard, real herdr named-session proof, real projector install readback) that are not present in this checkout.

# Phase 19 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail. Current verdict: **BLOCKED at the high-severity gate**: 17/20 CLOSED, 3 OPEN (1 high, 2 low), `threats_open: 1`. No risk acceptance, signed security gate or shipping approval is issued.

---

## Scope and Evidence Standard

Authored register: T-19-01 through T-19-20 (18 mitigate, 2 accept, 0 transfer), ASVS L1.

Source references are to `/root/src/repos/agent-substrate` at `6d0adafd` (branch `reconcile/main-2026-11-11`). Line numbers were re-read against this checkout; the prior line numbers were stale. A threat is CLOSED only when the mitigating code is located here **and** a covering test was run in this audit: `bun test` on 8 files (280 pass / 0 fail), `scripts/rehearsal.test.ts` (103 pass / 0 fail), and `packages/mcp-server/src/event.test.ts` (37 pass / 0 fail). `scripts/laneb-proof.ts` needs a live rehearsal ledger; it was read, not executed.

---

## Trust Boundaries

| Boundary | Data Crossing |
|----------|---------------|
| Collector → POST /events | Event metadata and bearer |
| Refusal file / journal | Fixed refusal metadata only |
| Pane cwd → git → event | Repo slug and branch |
| herdr socket → collector | Pane identity and status (snapshot reconcile) |
| Cursor stop hook → filesystem | Transcript path, conversation ID, transcript text |
| Brief response → repo files | Redacted brief, AGENTS pointer |
| Projector → bundle / installed cache | Config holds token-file path, not token value |
| Installed hook → events endpoint | Configured URL and conditional bearer (**installed-config guard absent, see T-19-14**) |
| Proof → fixture runtime / user-scope Muse | Scratch dirs, fixture socket, bundle-only projection |
| Agent → operator | Production unit, plugin and hook cutover remains operator-owned |

---

## Threat Register

Status key: CLOSED = mitigation located and covering test run now (or, where stated, the proof assertion is read and its primitive is tested). OPEN = mitigation absent, or disposition `accept` with no documented acceptance.

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Evidence (this checkout) | Test run now | Status |
|-----------|----------|-----------|----------|-------------|---------------------------------------|--------------|--------|
| T-19-01 | Information disclosure | recordRefusal refused line | high | mitigate | `packages/collectors/src/emit.ts:202-219` writes exactly `ts,collector,source,kind,surface,status,error`; error via `redact()` and 200-char cap; no summary/payload. Projector twin `packages/projector/src/muse.ts:178-202`. | `emit.test.ts` "refused line › keys are exact, the error is redacted and truncated, summary and payload never land" | CLOSED |
| T-19-02 | Information disclosure | SUBSTRATE_TOKEN handling | high | mitigate | `emit.ts:416` call-time `resolveBearer`; `packages/cli/src/token.ts:62-77` reads without logging; collector bearer `muse.ts:136-139` (no logging; journal at 124-130); projector hook token from file `muse.ts:138-151`. | `emit.test.ts` "bearer convention and call-time env"; `token.test.ts` "absent everywhere means no bearer" | CLOSED |
| T-19-03 | Denial of service | emit timeouts | medium | mitigate | `emit.ts:62-64` 3000/1500 ms constants; `emit.ts:425` `AbortSignal.timeout`; failure returned as a result, not thrown (`:434-438`). Hook budget in projector `muse.ts` (`remainingMs`, `AbortSignal.timeout(remainingMs())`). No retry queue. | `emit.test.ts` "a hung server maps to failed once the timeout fires"; `projector/muse.test.ts` "a collector that never answers cannot hold the turn past the budget" | CLOSED |
| T-19-04 | Tampering | grok state counters key | low | accept | Reserved `counters` key and finite-number filtering at `packages/collectors/src/grok.ts:47-66`. Disposition is `accept`; no Accepted Risks Log entry exists (see below). | not cited as closure | OPEN — low, non-blocking (accept undocumented) |
| T-19-05 | Spoofing | herdr pushes | medium | mitigate | `herdr.ts:170-178` push → dirty; `:181-202` single-flight pump; `:204-210` 5 s poll; `:249-256` snapshot reconcile is the source of truth. | `herdr.test.ts` "two near-simultaneous pushes yield one session.start"; "startWatch runs the first pass through the single-flight pump" | CLOSED |
| T-19-06 | Information disclosure | pane summaries and output_matched text | high | mitigate | `herdr-map.ts:123-159` fixed lifecycle summaries; `:167-190` matched text through `redact()`, no `repo`; `herdr.ts:48-50` per-pane subscription is `pane.agent_status_changed` only. | `herdr-map.test.ts` "redacts matched text and omits repo"; `herdr.test.ts` "one subscribe per connection" | CLOSED |
| T-19-07 | Denial of service | per-pane connections | medium | mitigate | `herdr.ts:401-429` `arm()`: error/close/RPC error calls `drop()` with no immediate reconnect (comment at `:423`); the 5 s pass reopens. `:368-378` reconcile opens/closes per pane. | `herdr.test.ts` "one subscribe per connection, and a bad pane closes only itself" | CLOSED |
| T-19-08 | Tampering | pane_exited repo amendment | low | mitigate | `packages/mcp-server/src/event-sources.ts:105-121` `carriesRepo: true`, sample carries `repo`; `docs/event-vocabulary.md:102` row `herdr.pane_exited … pane cwd slug`. | `event-sources.test.ts` "the repo rule" (106-120) and doc-equality tests | CLOSED |
| T-19-09 | Information disclosure / Tampering | transcript path traversal and TOCTOU | high | mitigate | `cursor-stop.ts:32-34` root and 20 MB cap; `:37` id regex; `:137-157` `resolveTranscript` realpath + root-prefix check; `:109-123` `openRegularFile` with `O_NOFOLLOW` and fstat regular-file check; `:168-208` `copyTranscript` size check, `O_EXCL` 0600 tmp, rename. *Residual:* `O_NOFOLLOW` covers only the final path component; a directory component swapped between realpath and reopen is not caught. Exploiting it needs write access under `~/.cursor`, so impact is low. | `cursor-stop.test.ts` "refuses a symlink under root that points outside it"; "a fifo under root is refused without blocking"; "refuses a source over the size cap"; "an out-of-root path emits a null ref and writes nothing" | CLOSED (residual noted) |
| T-19-10 | Information disclosure | secrets in transcripts and briefs on disk | high | mitigate | `cursor-stop.ts:183` whole-text `redact()` before copy; `collectors/src/muse.ts:421` `writeIfChanged(briefPath, redact(text))`; `mcp-server/src/event.ts:146-147` `clean()` redacts; `:188` `redactValue` on payload. | `cursor-stop.test.ts` "writes a redacted 0600 copy into a 0700 dir through a tmp name"; `event.test.ts` "redacts the summary and the payload on the write path", "redacts every free-text field" | CLOSED |
| T-19-11 | Tampering | writer scope escape | medium | mitigate | `collectors/src/muse.ts:145-156` `repoList` requires absolute roots, no default; `:262-302` `ensurePointer` writes only `AGENTS.md` at repo root with marker-span handling; `:309-335` `ensureExclude` (git-local); `:352-376` `briefPathFor` refuses linked `.substrate`. | `muse.test.ts` "SUBSTRATE_MUSE_REPOS is required and relative entries are rejected"; "a linked .substrate refuses the brief and keeps the target untouched"; ".substrate is excluded locally, including in a linked worktree" | CLOSED |
| T-19-12 | Tampering | stdout injection into Cursor followup | medium | mitigate | `cursor-stop.ts:212` "never writes to stdout"; the file writes only to stderr. Projector hook (HOOK_LINES) writes no stdout and ends `process.exit(0)` (`projector/src/muse.ts:253`). | `cursor-stop.test.ts` "a rejecting emit is swallowed and nothing is written to stdout"; "stdout stays empty and the process exits 0"; `projector/muse.test.ts` "a dead url exits 0 with empty stdout" | CLOSED |
| T-19-13 | Information disclosure | token value in bundle or cache | high | mitigate | `projector/src/muse.ts:60-66` `substrateConfig` holds token-file path only; `:295-298` refuses to write a bundle containing the token value. | `projector/muse.test.ts` "--bundle-only writes the redactor bytes and a config with no token value" | CLOSED |
| T-19-14 | Tampering | hook posting to production | high | mitigate | **Authored mechanism absent in this checkout:** no installed-config equality guard (`assertHookTarget` does not exist anywhere in the repo), no installed `hooks/substrate.json` readback, and no installed `muse plugins hook test` step in `scripts/laneb-proof.ts`. *Partial:* the generated hook reads only its configured URL and posts nothing when the config is missing (`projector/src/muse.ts:125-136, 204-206`); the proof refuses non-loopback and production-port targets before any request (`scripts/laneb-proof.ts:156-160`). Neither covers an operator-installed hook whose configured URL points at production; the default projected URL is `:7410` (`projector/src/muse.ts:21`). | `projector/muse.test.ts` "a substrate.json with a non-string field … nothing is posted"; `rehearsal.test.ts` "refuseSmokeUrl" (covers the proof's partial guard). Installed-target guard: no test exists. | OPEN — high, **blocking** |
| T-19-15 | Information disclosure | redactor drift between repo and bundle | medium | mitigate | `projector/src/muse.ts:262-269` `assertCopyable` refuses imports; `:271-281` source commit; `:283-288` header records commit + sha256; `:444-475` `checkInstalled` compares installed files by sha256 (including `hooks/redact.ts`). | `projector/muse.test.ts` "--check is already current …"; "--check notices a manifest-only drift" | CLOSED |
| T-19-16 | Elevation of privilege | user-scope install confusion | medium | mitigate | Projector: `muse.ts:477-527` validate gate, install/update, approve; `:508-514` `--bundle-only` never installs. Proof: `scripts/laneb-proof.ts:51-61` explicit-key child env (no `HERDR_*`, no XDG), `MUSE_NO_AUTO_UPDATE=1`; `:264-280` bundle into scratch dir only, operator cache paths compared before/after. *Not in this checkout:* the register's real projector install into scratch HOME with installed readback. Closure rests on the bundle-only isolation and the tested install path. | `projector/muse.test.ts` "a failing validate does not install"; "install then approve, and a second run updates"; "--check … exits 1 on drift or untrusted status" | CLOSED (weaker than register text) |
| T-19-17 | Tampering (production) | proof targeting | high | mitigate | `scripts/laneb-proof.ts:156-160` `refuseSmokeUrl` before any request or child; `:165-167` `HERDR_*` env cleared; `:231-239` collector bound only to a fixture socket in the scratch dir (no default herdr socket); `:378-386` finally stops collector, closes server, restores env, `rmSync` scratch. | `rehearsal.test.ts` "refuses :7410 even on loopback", "refuses non-loopback hosts on any port", "accepts loopback twins"; `herdr.test.ts` "session wins, then the env, then the default…" | CLOSED (named real-session mechanics absent in main; not needed for closure) |
| T-19-18 | Tampering | unit install | medium | mitigate | `docs/runbooks/lane-b-collectors.md:80-86` "Who does what": operator owns window, install, restarts, user-scope projection; `:87-97` manual-only verifications. Proof contains no `systemctl`, no `hooks.json` edit, no restart (grep). | Process control; verified by grep and runbook read, no code test | CLOSED |
| T-19-19 | Repudiation | proof evidence | low | accept | Proof run tag and status check: `scripts/laneb-proof.ts:162` tag, `:377` zero-refused status. Disposition is `accept`; no Accepted Risks Log entry exists. | n/a | OPEN — low, non-blocking (accept undocumented) |
| T-19-20 | Information disclosure | decoy transcript in proof | medium | mitigate | `scripts/laneb-proof.ts:315-334` runtime-assembled shape, 0600 copy, absence assertion; `:378-386` finally removes scratch dir. | `cursor-stop.test.ts` "writes a redacted 0600 copy …" (primitive). Proof-run assertions not executed in this audit. | CLOSED |

**Counts:** 20 authored. CLOSED 17. OPEN 3: T-19-14 (high, blocking), T-19-04 and T-19-19 (low, accept with no documented acceptance). `threats_open = 1` (only T-19-14 is at or above block_on `high`).

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|

**No documented accepted risks.** T-19-04 and T-19-19 are `accept` dispositions with plan-time rationale (`19-01-PLAN.md:174`, `19-05-PLAN.md:179`) but no approving actor or date. This audit does not accept them. T-19-14 cannot be accepted by this audit; a risk acceptance would need a named owner, a date and a rationale recorded here.

### Open — Blocking

| Threat ID | Severity | Gap | Required to close |
|-----------|----------|-----|-------------------|
| T-19-14 | high | No installed-hook target guard in main. Nothing checks that an installed `hooks/substrate.json` points at the scratch twin before the hook runs. The default projected URL is production `:7410`. | Add an installed-config equality and smoke-URL guard that refuses production targets before any installed hook runs, plus a test that exercises the refusal. Or record an owner-signed acceptance here. |

### Open — Non-Blocking

| Threat ID | Severity | Gap |
|-----------|----------|-----|
| T-19-04 | low | `accept` disposition, no acceptance record. |
| T-19-19 | low | `accept` disposition, no acceptance record. |

---

## Summary Threat Flags

Not re-audited in this revision. The earlier claim that every SUMMARY threat flag maps to the register is unverified against this checkout.

---

## Real-Runtime Evidence and Provenance

- The earlier real-runtime receipt (41/41, herdr 0.9.1 named session, scratch-HOME Muse install) was produced against the out-of-tree worktree. It is **not evidence for this checkout**. `scripts/laneb-proof.ts` here uses a fixture socket and bundle-only projection; it does not run a named herdr session or install into scratch HOME.
- This audit ran no live proof, no rehearsal, no production probe and no install.
- Runbook status (`docs/runbooks/lane-b-collectors.md:10-14`) records an operator-approved 2026-10-10 cutover. That is an operator attribution, not a verification by this audit.
- Full-suite green is not claimed. This audit ran only the test files named above.

---

## Global Operator Action — Cursor Credential Exposure

**Status: operator_rotation_pending; not accepted; not rotated.** The test fallback credential disclosure is contained by the scratch empty-token-directory fixture in `packages/cli/src/token.test.ts:108-110`; "absent everywhere means no bearer" passed in this audit. Containment does not revoke the exposed credential. Operator must rotate or revoke it and record completion without writing its value. This audit read no credential, token file or `/etc` environment file.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-10 | 20 | 15 | 5 (2 blocking, 3 non-blocking) | Earlier read-only audit against the out-of-tree worktree; superseded |
| 2026-10-10 | 20 | 18 | 2 (0 blocking, 2 non-blocking) | Earlier read-only reassessment against the out-of-tree worktree; superseded. Its "SECURED" verdict is withdrawn. |
| 2026-11-12 | 20 | 17 | 3 (1 blocking high, 2 non-blocking low) | secure-phase review against `reconcile/main-2026-11-11` @ `6d0adafd`: source re-read, `bun test` on 8 collector/projector/cli/mcp-server files (280 pass), rehearsal and event suites run. No git commit, no push, no VERIFICATION.md edit. |

---

## Sign-Off

- [x] All 20 authored threats classified against the current checkout, with file:line evidence.
- [x] Covering tests run now for every CLOSED threat that rests on a test.
- [ ] T-19-14 mitigated (installed-hook target guard absent).
- [ ] Accept dispositions documented — T-19-04 and T-19-19 remain undocumented.
- [ ] Parent final union verification and source fingerprint recorded.
- [ ] Phase status set by parent. Frontmatter is `blocked` with `threats_open: 1`.

**Verdict:** BLOCKED. One high-severity threat (T-19-14) is OPEN with no covering guard in this checkout. Two low-severity accept threats are undocumented. Phase advancement is blocked until T-19-14 is mitigated and tested, or an owner documents an acceptance here.
