---
phase: "3"
slug: "lane-a"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-25"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `03-RESEARCH.md` § Validation Architecture, reconciled with the
> locked decisions D-01..D-16 in `03-CONTEXT.md`.

---

## Test Infrastructure

Phase 3 touches the TypeScript monorepo (`packages/mcp-server`, a new `packages/host`), the
Python dispatcher (`packages/dispatcher`), `infra/` (a sandbox Dockerfile and a new systemd
unit), and live services (rivet engine, Docker, Telegram, Linear, Notion, GitHub).

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root) + `bunx tsc --noEmit`; colocated `packages/*/src/*.test.ts`. `packages/host` tests cover pure modules only (no `@rivet-dev/*` import), so root `bun test` stays green without Node-only deps |
| **Framework (Python)** | system `python3 -m pytest` in `packages/dispatcher` (`pyproject.toml` `testpaths=["tests"]`, httpx already installed; no venv, no uv) |
| **Runtime (host)** | Node 24.18 runs `packages/host` (rivet needs node ≥ 22 and Node-ABI napi binaries); deps installed with `npm` inside `packages/host` |
| **Config file** | root `package.json` / `tsconfig.json`; `packages/dispatcher/pyproject.toml`; `packages/host/package.json` (exists, stub) |
| **Quick run command** | the targeted test file for the task (table below) |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q)` |
| **Estimated runtime** | < 30 s per suite (live spike and proof excluded) |

| Repo / package | Quick run command | Baseline (measured 2026-09-25, 03-RESEARCH.md § Validation Architecture) |
|---|---|---|
| agent-substrate (TS) | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | **167 pass / 0 fail**, 11 files |
| agent-substrate (tsc) | `cd /root/src/repos/agent-substrate && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit` | **exit 0**, no output |
| dispatcher (Python) | `cd /root/src/repos/agent-substrate/packages/dispatcher && python3 -m pytest -q` | **114 passed** |

All three baselines are green, so the gates are "stay green + new tests pass". The two-sided rule
still applies: re-measure immediately before the first edit in each package; if another session
has turned a suite red in the meantime, record the failing ids and gate two-sided against them
(a vanished failure fails the gate exactly as a new one does) — do not repair them.

---

## Sampling Rate

- **After every task commit:** the targeted test file for the touched module.
- **After every plan wave:** full `bun test` + `bunx tsc --noEmit` + dispatcher pytest.
- **Before `/gsd:verify-work`:** all suites green against the baselines above (counts ≥ baseline plus new tests), plus the live evidence in the spike and proof files.
- **Max feedback latency:** 30 seconds.

---

## Per-Task Verification Map

> No REQUIREMENTS.md exists. Rows are keyed to ROADMAP success criteria (SC-1..SC-4, Proof) and
> CONTEXT decisions. Reconciled with plans 03-01..03-10 after planner revision 2 (test file names
> below are the ones the plans create).

| Behavior | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|
| Free disk ≥ 10 GiB (`df --output=avail -B1 /` ≥ 10737418240) checked and recorded before the npm install and before every image build/pull; refuse below | SC-1, D-03 | — | refuses rather than filling `/` | live gate | spike/build step records `disk_before` / `disk_after_*` in the evidence file | ❌ plan 03-01 | ⬜ pending |
| No other project's Docker data removed (`asterinas/dev` image and `bold_rosalind` container still present) | D-04 | — | N/A | live check | `docker image inspect asterinas/dev:0.18.1-20260901` and `docker ps -a --filter name=bold_rosalind` exit 0 before/after | ✅ | ⬜ pending |
| Spike answers (a) host-loopback reachability, (b) hooks/skills/`.claude.json` MCP under the adapter, (c) git in VM / sandbox, plus durability mini-check; `route_choice`, `tracker_route` (vm_mcp \| host) and `tests_route` (sandbox \| oneshot \| none) recorded | D-09, D-10, D-11 | T-3 loopback, T-3 VM | negative control denied without exemption | live spike | keys in `03-01-SPIKE.md` (`a_loopback`, `a_model`, `b_hooks`, `b_skills`, `b_claude_json_mcp`, `b_session_mcp_names`, `c_vm_git`, `c_sandbox_git`, `c_push_hostfn`, `durability`, `engine_bind`, `route_choice`, `tracker_route`, `tests_route`) | ❌ plan 03-01 | ⬜ pending |
| Engine (:6420-6422), host API (:7411) and sandbox-agent ports bind 127.0.0.1 only | D-05, D-01 | T-3 exposure | no 0.0.0.0 listener | live check | `ss -ltnp` shows only `127.0.0.1:` for those ports | ❌ | ⬜ pending |
| Custom sandbox provider: `HostIp 127.0.0.1`, per-container token, `substrate.graph_id` label, worktree bind, no `--privileged`, no docker socket | D-01, D-02 | T-3 sandbox RCE | unauthenticated command server impossible | unit (pure option builder) + live `docker inspect` | `bun test packages/host/src/sandbox-options.test.ts` | ❌ plan 03-01 | ⬜ pending |
| `issue_get(graph_id, node_id)` returns redacted title/description of the node's Linear issue, wrapped as untrusted; missing graph/node/ref or Linear off → `found:false` | D-15 | T-3 injection | prompts stay ids-only; issue text redacted and framed as untrusted | unit | `SUBSTRATE_DISABLED=1 bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| Plain HTTP `POST /issue` route for hooks; 400 on missing ids | D-15 | T-3 injection | body size limit as server.ts `MAX_BODY_BYTES` | unit | `SUBSTRATE_DISABLED=1 bun test packages/mcp-server/src/server.test.ts` | ❌ plan 03-02 | ⬜ pending |
| Hermes and claude-code prompts: ids only, an `issue_get` step, a "release and stop" step with the same session id, surface string matches the claim | D-15 | T-2-01 | no untrusted issue text in prompts | unit | `cd packages/dispatcher && python3 -m pytest -q tests/test_launcher.py` | ✅ update | ⬜ pending |
| `CHILD_ENV_ALLOW` carries the root-trust note (IN-01) | D-16 | — | documented assumption | source assertion | `grep -n 'root' packages/dispatcher/src/substrate_dispatcher/launcher.py` near `CHILD_ENV_ALLOW` | ✅ | ⬜ pending |
| `dispatch:claude-code` is dispatchable; the launch branch calls the host `openTask`; `Launched.proc` is a remote handle | SC-3, D-06 | — | N/A | unit | `cd packages/dispatcher && python3 -m pytest -q tests/test_dispatch.py` | ✅ extend | ⬜ pending |
| Remote handle: `poll()` None while running/waiting, 0 on end_turn, 1 on failed/cancelled, host-unreachable tolerated then logged; `terminate()`/`kill()` hit host routes | D-06 | — | host API loopback-only | unit (httpx MockTransport) | `cd packages/dispatcher && python3 -m pytest -q tests/test_host.py` | ❌ W0 | ⬜ pending |
| Registry with a remote handle: 900 s claim timeout, landed-claim rule, SIGTERM→SIGKILL equivalents unchanged | D-06 | T-2-04 | bounded sessions | unit | `cd packages/dispatcher && python3 -m pytest -q tests/test_sessions.py` | ✅ | ⬜ pending |
| One VM per Graph ID (`vm.getOrCreate(graph_id)`); `openTask` idempotent for an existing task (no re-prompt) | D-06 | — | N/A | unit (fake client) + live | `bun test packages/host/src/tasks.test.ts` | ❌ W0 | ⬜ pending |
| `openTask` seeds `/home/agentos`: skills, `SUBSTRATE_BRIEF.md`, and `.claude.json` with `substrate`, `notion` and `linear` servers on every route (notion/linear → loopback tracker proxy `127.0.0.1:7412`, no headers/env); live on `tracker_route=vm_mcp`, seeded-but-inert on `host`; no substrate.env content, no keys in session `env` (except the sanctioned model key on `a:anthropic_key`) | SC-2, D-08, D-11 | T-3 plaintext DB | secrets never persisted in rivet DB | unit (seed builder) + live read-back | `bun test packages/host/src/seed.test.ts` + live file listing in the tracer evidence | ❌ plans 03-03/03-04 | ⬜ pending |
| Tracker proxy: loopback-only, bridges to host `ultrathink-mcp serve notion\|linear`, refuses Linear state/stateId/statusId writes and Notion `Completed` / terminal `Status` (Merged, Done, Failed, Blocked) writes (Done only via DoD gate), logs names only | SC-2, SC-4, D-08, D-10 | T-3 plaintext DB | host credentials never enter the VM | unit + live tool-count and refusal on `vm_mcp` | `bun test packages/host/src/mcp-proxy.test.ts` | ❌ plan 03-04 | ⬜ pending |
| Host functions bound to the actor's graph: `hostCallTarget` (tasks.ts) takes the graph from the actor key, validates `--node`, requires a task record and refuses guest `--graph`/`--session` — used by vm.ts issue-get, release, complete (03-03) and run-tests (03-04); git-push / pr-create / commit in hostfns.ts refuse scratch `.substrate-*` files before any push | D-08, D-10 | T-3 VM escape | no guest-chosen path/remote; owner PAT never in VM/container | unit | `bun test packages/host/src/tasks.test.ts` (hostCallTarget) + `bun test packages/host/src/hostfns.test.ts` (push/PR/commit guards) | ❌ plans 03-03/03-04/03-07 | ⬜ pending |
| Sync route by `tracker_route`: model via MCP on `vm_mcp`; host function or host backstop otherwise (`sync_by` recorded, D-10 deviation on host) | SC-4, D-10 | — | sync writes PR fields only; Done via `graph_complete` | unit | `bun test packages/host/src/sync.test.ts` | ❌ plan 03-07 | ⬜ pending |
| Storage audit: secret-named substrate.env keys (segment KEY/TOKEN/SECRET/PASSWORD/PAT/CREDENTIAL/PRIVATE/COOKIE) absent from rivet storage (`secret_hits_total=0`, `secret_keys` includes LINEAR_API_KEY); non-secret config keys reported separately (`config_hits_*`); sanctioned model key reported by name on `a:anthropic_key` | D-08 | T-3 plaintext DB | plaintext DB holds no unsanctioned secret | unit + live audit | `bun test packages/host/src/audit.test.ts` | ❌ plan 03-06 | ⬜ pending |
| Task state machine: interrupted turn detected on boot → exactly one continuation prompt (idempotency key) | D-07 | — | N/A | unit (fake handle) | `bun test packages/host/src/tasks.test.ts` | ❌ W0 | ⬜ pending |
| Telegram codec: callback_data ≤ 64 bytes, opaque single-use key, unauthorised chat/user rejected, unknown key → expired, only Approve (allow_once) and Deny (reject_once) offered and any other option index refused, never auto-approve | SC-3, D-13 | T-3 spoofing | approvals only from configured user ids in configured chat; one tap per tool call | unit | `bun test packages/host/src/telegram.test.ts` | ❌ W0 | ⬜ pending |
| VM egress: only shunt (loopback), substrate-mcp (loopback), the tracker proxy (loopback, `vm_mcp` only), mcp.notion.com, mcp.linear.app, api.greptile.com, github.com + API host; everything else denied. Sandbox container: denied on `sandbox_net=internal`; on `published_loopback` open egress is recorded as a D-12 deviation in Gaps | D-12 | T-3 egress | default deny | unit (permission builder) + live negative probes from VM and container | `bun test packages/host/src/options.test.ts` + spike/containment probes (`vm_example_com`, `container_example_com`) | ❌ plans 03-01/03-03/03-04/03-06 | ⬜ pending |
| substrate-host is its own systemd unit; restarting substrate-dispatcher does not stop VMs | D-05 | — | N/A | live smoke | `systemctl is-active substrate-host` before and after `systemctl restart substrate-dispatcher`, VM task still reported by the host | ❌ | ⬜ pending |
| Dispatch kill switch honoured: `SUBSTRATE_DISPATCH_DISABLED=1` at rest, `=0` only inside the proof window (closed by an EXIT trap on every path) | Phase 2 owner direction | T-2-04 | kill switch | live check | `sudo awk -F= '/^SUBSTRATE_DISPATCH_DISABLED=/{v=$2} END{exit !(v=="1")}' /etc/substrate/substrate.env` exits 0 (last switch line is `=1`; prints nothing) | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] D-03 disk check (≥ 10 GiB free) recorded immediately before `npm install` in `packages/host` and before the sandbox image build (base image pull included).
- [ ] Human-verify checkpoint before installing the SUS-flagged first-party rivet packages (`@rivet-dev/agentos`, `@rivet-dev/agentos-sandbox`, transitive `@agentos-software/claude-code`, `rivetkit`; `@agentos-software/git` only if spike (c) chooses VM git).
- [ ] D-09 spike evidence `03-01-SPIKE.md` with `route_choice`, read by every later plan to pick the primary route or its fallback.
- [ ] `packages/dispatcher/tests/test_host.py` — remote handle and host client over `httpx.MockTransport`.
- [ ] `packages/host/src/*.test.ts` for pure modules (telegram, tasks, seed, options, sandbox-options, api, mcp-proxy, hostfns, sync, audit) — no rivet import.
- [ ] Route test for `POST /issue` in `packages/mcp-server/src/server.test.ts`.
- [ ] Root `bunx tsc --noEmit` stays exit 0 after the host install (root `tsconfig.json` includes `packages/**/*.ts`; host sources importing `@rivet-dev/agentos` must resolve from `packages/host/node_modules`).
- [ ] Owner checkpoint (D-13): new Telegram approval bot token, chat id and approver user ids appended to `/etc/substrate/substrate.env` without printing them; presence verified with `sudo grep -c`.
- [ ] D-14: archives under owner-decision-2 rules, exactly (active count − 249) at execution (research measured 251 → 2), recorded in `02-LINEAR-ARCHIVED.md` under a Phase 3 heading, before the proof issue is created.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Phase proof: a labelled `dispatch:claude-code` issue opens a VM, the session survives a `substrate-host` restart, a PR lands, and `ultrathink-sync` (or the recorded D-10 host-side fallback) closes the loop in Notion and Linear | Proof, SC-2..SC-4, D-07, D-10, D-14 | spans live Linear, Notion, GitHub, Telegram, a rivet VM and a live model session | Record timestamps for label, openTask, claim, seed files, first approval, restart, post-restart prompt, PR URL, sync writes and final Linear state in the proof evidence file. Anything the run cannot observe (for example model-authored sync steps) is recorded under `## Gaps`, never asserted. |
| Telegram approval round-trip | SC-3, D-13 | needs a human tap on a phone | Owner taps Approve on one request and Deny on another; host log and `readHistory` show the matching `respondPermission` outcomes; no request auto-approved. |
| "PR lands" meaning | Proof | owner decision (opened vs merged; repo) | Proof plan presents the options from 03-RESEARCH.md Open Question 8 at a checkpoint; record the choice and the PR URL/state. |
| Telegram bot creation | D-13 | only the owner can create a bot with BotFather | Owner creates the bot, starts a chat with it, appends `SUBSTRATE_APPROVAL_BOT_TOKEN`, `SUBSTRATE_APPROVAL_CHAT_ID`, `SUBSTRATE_APPROVAL_USER_IDS` to substrate.env (append-only). |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before first edit; any pre-existing red gated two-sided
- [ ] Dispatch OFF at rest; ON only inside the tracer and proof windows
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
