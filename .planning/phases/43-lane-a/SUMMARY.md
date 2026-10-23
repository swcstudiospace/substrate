---
phase: 43-lane-a
requirements: [H-D1, H-D3]
status: in review (draft PR). In-repo gates green. The live egress proof and a live dispatcher restart are operator-gated
---

# 43-SUMMARY: LANE-A

## Built

- **VM-task re-adoption after a dispatcher restart (criterion 2).** The dispatcher now persists each VM-task record to `<STATE_DIR>/vm_tasks.json` (0600 file, 0700 directory, atomic replace). On start, `SessionRegistry.readopt()` runs before the first reap. It re-attaches a running task with a RemoteTask watcher, counts it toward `max_sessions`, and re-adopts a finished task so reap handles it. A 404 drops the record. An unreachable host keeps the record for up to 60 attempts (`READOPT_UNREACHABLE_LIMIT`), then drops it with a log line. Dry runs never adopt tasks or write the file.
- **Give-up drops the record first.** A terminating task's record is removed before `dispatch.failed` is emitted, so a restart in that window cannot emit a second failure.
- **A pending record counts as active** for both the issue and the graph. A tick therefore cannot open a second VM task on a graph whose task is still running.
- **The record is written before the launch call.** A VM task's record is written before `launch_fn` runs. It is removed only when the host definitively refuses the launch (`HostRefused.may_be_open` is False). A dispatcher that dies inside the launch re-adopts the task on its next start, through the same status path as every other record.
- **Claim evidence is persisted.** When a claim lands, `claimed_at` and `claim_session` are written to the VM-task record and restored by `readopt()`, so a restarted session that lost its claim comment is not turned into an exited-unclaimed failure.
- **Pending records hold slots.** A pending record holds one of the `max_sessions` slots, so a tick cannot launch a Hermes session past the cap while a re-adoption is pending. `readopt()` still adopts up to the free session slots.
- **Ambiguous host replies keep their record.** `HostRefused` carries `may_be_open`. A connect failure or a 4xx refusal says no task was opened, and only those drop the record. A lost reply, a 5xx, or an accepted 2xx whose body cannot be read keeps it, so `readopt()` can resolve a task the host did open. A route test that pinned a second POST after an unreadable 200 is split: the connect-failure retry is kept, and the accepted-reply case now asserts that no second POST is made.
- **Prior claims are persisted** (`prior_claim_sessions`). Without this, a claim comment left by an earlier session on the same node would count as the re-adopted task's own claim. The gap was found in review on this phase and fixed in the same phase, with its own test (`test_a_claim_from_an_earlier_session_is_not_counted_for_a_readopted_task`).
- **Hermes sessions are not persisted**, by design (D43-a). `KillMode=control-group` ends them on a dispatcher restart, and that kill switch is kept.
- **Egress regression test.** `packages/host/src/sandbox-options.test.ts` gets one test: an unlisted host gets no accept rule, and the source DROP is the last rule. The composition behaviour itself was already on main.
- **Docs.** `docs/runbooks/lane-a-host.md` gains a "Restarts" section with the re-adoption log line. `docs/dispatcher.md` restart statement and the `host.py` docstring are updated to match.

## Verified in-repo

- Python dispatcher suite: 267 passed. `packages/dispatcher/tests/test_readoption.py` holds 15 tests. The review round added five: the pending-record launch, claim evidence, slot accounting, and the two `may_be_open` cases.
- Host sandbox options: 35 pass, including the new unlisted-host test.
- Full gate on this tree: `bunx tsc --noEmit` exit 0; `bun test` 5824 pass, 2 skip (pre-existing), 0 fail over 5826 tests in 217 files; `check:phase-close` green.

## Deviations

- The `prior_claim_sessions` field was not in the first plan. It came from review of the re-adoption path and is recorded in CONTEXT D43-f.
- `launch_state` is not persisted, so a re-adopted session starts with `None`, as the code already documents (D43-g).

## Not done

- **Live egress proof** on a host with the sandbox network up. Operator-gated.
- **Live dispatcher restart** with a running VM task, to watch re-adoption on real hardware. Operator-gated. The in-repo tests use a fake host.

## Cleanup

- The worktree `/root/pr-fix/v143-lanea` stays until close-out, with the other phase worktrees, after the user approves cleanup.
