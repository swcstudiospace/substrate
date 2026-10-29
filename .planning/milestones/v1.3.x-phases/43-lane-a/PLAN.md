---
phase: 43-lane-a
requirements: [H-D1, H-D3]
status: executed in-repo 2026-10-21
---

# 43-PLAN: LANE-A

## Tasks (executed)

1. **VM-task persistence and re-adoption (dispatcher).** `packages/dispatcher/src/substrate_dispatcher/sessions.py` (record store, `readopt`, `_drop_session`, give-up path), `dispatch.py` (repo on the launched session), `__main__.py` (`readopt` before each reap, host passed to the registry). Tests in `packages/dispatcher/tests/test_readoption.py`: 10 tests, including the restart, 404, finished, unreachable, capacity, Hermes, corrupt-file and permission cases, and the prior-claim case.
2. **Egress regression test (host).** `packages/host/src/sandbox-options.test.ts`: one test that an unlisted host gets no accept rule and the source DROP is last.
3. **Restart runbook (docs).** `docs/runbooks/lane-a-host.md` "Restarts" section; `docs/dispatcher.md` restart statement.
4. **Gates.** Python dispatcher suite, the host egress test file, typecheck, full bun suite, repo locks.

## Acceptance

- Criterion 1 is proven by the existing composition tests plus the new unlisted-host test. The live enforcement check on a host is operator-gated.
- Criterion 2 is proven in-repo by the re-adoption tests with a fake host. A live dispatcher restart is operator-gated.
