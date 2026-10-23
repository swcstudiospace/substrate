---
phase: 43-lane-a
verified: 2026-10-21
status: passed in-repo. The live egress proof and the live restart are operator-gated and were not run
score: 2 of 2 criteria proven in-repo (H-D1 egress composition, H-D3 VM-task re-adoption); live proofs not run
verified_on: gsd/v13x-43-lane-a on its final tree, against origin/main 3e9a106 as the base
covered_files: ["packages/dispatcher/src/substrate_dispatcher/sessions.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/tests/test_readoption.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_claude_code_route.py", "packages/host/src/sandbox-options.test.ts", "docs/runbooks/lane-a-host.md", "docs/dispatcher.md"]
---

# 43-VERIFICATION: LANE-A

## Gates on the final tree

| Check | Command | Result |
|---|---|---|
| Dispatcher suite | `python3 -m pytest packages/dispatcher/tests` | 267 passed |
| Re-adoption tests | `packages/dispatcher/tests/test_readoption.py` (within the suite) | 15 tests, all pass |
| Host egress composition | `bun test packages/host/src/sandbox-options.test.ts` | 35 pass, 0 fail |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Full bun suite | `bun test` against `substrate_test_p43` | 5824 pass, 2 skip, 0 fail (5826 tests, 217 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 27 |

## Criteria

| Criterion | Evidence in repo | Status |
|---|---|---|
| H-D1 egress allowlist enforced | Composition tests on main; new test: an unlisted host gets no accept rule and the source DROP is last | Proven in-repo. Live enforcement check not run (operator-gated) |
| H-D3 VM tasks re-adopted after a dispatcher restart | `test_readoption.py`: restart re-adopts a running task; 404 drops the record; a finished task is re-adopted for reap; an unreachable host keeps the record and then drops it after 60 attempts; corrupt file and permission cases; pending counts as active; give-up drops the record first; prior claims from an earlier session do not count as the task's own claim | Proven in-repo against a fake host. Live dispatcher restart not run (operator-gated) |

## Not proven

- Live egress enforcement on a host with the sandbox network up.
- A live dispatcher restart that re-adopts a running VM task on real hardware.
- Hermes sessions: not persisted by design (D43-a). Their end on restart is the intended behaviour.
