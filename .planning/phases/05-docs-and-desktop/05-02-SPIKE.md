# 05-02 RAGFlow owner inputs and live contract spike

Recorded from observed output only. No value of RAGFLOW_URL or RAGFLOW_API_KEY is recorded.

## Task 1 — pre-edit presence (2026-09-26T18:21:44Z, `sudo grep -c` / `sudo stat`)

env_ragflow_url_before=0
env_ragflow_key_before=0
env_ragflow_dataset_before=0
env_mode_before=600 root
restore_route_written=true

Rollback route: /var/lib/substrate/phase5-baseline/RESTORE.d/05-02.md (0600 root); pre-edit state equals 05-01's t0 presence file (t0-20260926T181142Z/substrate-env.presence, all RAGFLOW_* = 0).

## Owner report

Task 2 resume reply, verbatim (owner, relayed by the orchestrator on 2026-09-27):

    skip

No step-1 report and no confirmations were given. That means neither chat_model_unset nor tei_no_public_domain is confirmed.

## Task 2 presence at resume (2026-09-27T05:38:02Z, `sudo grep -c` / `sudo stat`)

ragflow_url_present=0
ragflow_key_present=0
ragflow_dataset_id_present=0
env_mode_after=600 root

## Result

spike_result=fail
spike_fail_reason=owner-skip

Task 3 did not run. No keyed probe ran. No request was sent to RAGFlow. No spike dataset was created, and /tmp/05-02-spike.ts was never written. substrate.env is unchanged from t0, so RESTORE.d/05-02.md route (a) has nothing to remove. The docs half stops here: 05-04, 05-05 and the docs half of 05-06 do not run, and there is no substitute docs backend (D-01).

## Gaps

- The live contract spike was not run (owner-skip). The RAGFlow version, the tenant embedding model, dup_name_behaviour, update_method, ref_metadata_url, filter_operator_ok, the parse timings (D-17), bad_key_http and the error codes are all unmeasured. The research Q1 contract remains unverified against the owner's instance.
- D-04/D-05/D-06 owner setup was not confirmed: no TEI sidecar, no default embedding, the chat model is not confirmed unset, and sign-up lock (register_enabled) is unverified.
