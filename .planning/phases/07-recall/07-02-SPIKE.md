# 07-02 Agentmemory owner inputs, version gate and live contract spike

Recorded from observed output only. No value of AGENTMEMORY_URL or AGENTMEMORY_SECRET is recorded.

## Task 1 — presence before the owner edit

env_agentmemory_url_before=0
env_agentmemory_secret_before=0
env_mode_before=600 root
restore_route_written=true

Source: `sudo grep -c '^AGENTMEMORY_URL=' /etc/substrate/substrate.env`,
`sudo grep -c '^AGENTMEMORY_SECRET=' /etc/substrate/substrate.env`,
`sudo stat -c '%a %U' /etc/substrate/substrate.env`. Rollback routes (env lines, owner-only
Railway routes, spike-memory forget) are in /var/lib/substrate/phase7-baseline/RESTORE.d/07-02.md
(0600 root); RESTORE.md was not edited.

## Owner report

Task 2 resume signal, verbatim:

> skip

## Result

agentmemory_url_present=0
agentmemory_secret_present=0
env_mode_after=600 root
spike_result=fail
spike_result_reason=owner-skip

The owner stopped recall at the Task 2 checkpoint. Task 3 did not run, so there was no keyed probe,
version gate, isolation check or contract spike, and no memory was written to Agentmemory.
/etc/substrate/substrate.env still has no AGENTMEMORY_* line. That was checked with
`sudo grep -c '^AGENTMEMORY_'` = 0, mode `600 root`. There is no substitute recall backend, so
07-04..07-08 do not run.
