---
phase: 03-lane-a
plan: 11
subsystem: infra
tags: [gap-closure, g5, sandbox-image, docker, cron, d-02, d-03]
gap_closure: true
fixes: [G5]

requires:
  - phase: 03-lane-a
    provides: 03-01 image route (03-01-SPIKE § Image), infra/sandbox/Dockerfile, substrateDocker provider
provides:
  - docker image substrate-sandbox:0.1 sha256:3c72e6c37d646df9347181311a97e63c2231ba3357a79585adafc14eaad27724, label org.swcstudio.substrate.keep=true
  - /etc/cron.d/docker-image-prune skips keep-labelled images (second --filter, label!=)
  - /var/lib/substrate/phase3-baseline (RESTORE.md, RESTORE.d/03-11.md, 03-11/20260928T021657Z/docker-image-prune snapshot)
affects: [03-10]

actuals:
  tasks: 2
  commits: 3
plan_head_before: bee0ce541620b5a93b504e4fbae6de44b1cd50cc

key-files:
  created:
    - .planning/phases/03-lane-a/03-11-PLAN.md
    - .planning/phases/03-lane-a/03-11-SUMMARY.md
  modified:
    - infra/sandbox/Dockerfile
    - /etc/cron.d/docker-image-prune (host, not in repo)

key-decisions:
  - "Keep label baked into the Dockerfile (LABEL), not a build --label, so any rebuild by the documented route stays exempt"
  - "Base node:24-bookworm-slim not labelled or protected: the runtime needs only the built image, the containerd image store did not keep the base as a tagged image after the build, a pulled image cannot carry a local label without a rebuild, and any rebuild re-pulls it with --pull under D-03"
  - "Proof through the host's own provider (substrateDocker) on a throwaway graph id with no graph registration and no dispatch"

duration: ~40min (build ~22 min on this host)
completed: 2026-09-28
---

# 03-11 — G5 gap closure: rebuild substrate-sandbox:0.1 and exempt it from the daily prune

**substrate-sandbox:0.1 is back, built by 03-01's route from the same base digest, labelled
`org.swcstudio.substrate.keep=true`, and the root prune cron now skips images carrying that label. A
sandbox started through substrateDocker answered `/v1/health` 200 with its token and 401 without.**

## Rollback area (written before any live change, 02:16:57Z)

/var/lib/substrate/phase3-baseline did not exist (Phase 3 predates the per-phase area), so it was
created in the Phase 4–7 layout: directory, RESTORE.d/, 03-11/ and 03-11/20260928T021657Z/ are 0700;
RESTORE.md, RESTORE.d/03-11.md and the snapshot are 0600 root.

- Snapshot `03-11/20260928T021657Z/docker-image-prune` (`cp -p`, mtime 2026-06-23 12:26:43.465169897 +0000 kept):
  sha256 `5fa79cdbff53028f6afca3cb3ce2d2b95c1609b8b9a0c49cb0044aa7ed45272e`, equal to the live file before the edit.
- RESTORE.d/03-11.md routes: (a) `install -m 0644 -o root -g root` the snapshot back + `touch -d` the
  original mtime, expect the original sha256; (b) `docker image rm substrate-sandbox:0.1` when no
  container uses it (and the base if tagged); (c) revert the `feat(03-11)` Dockerfile commit, together with (a).

## Task 1 — keep label and rebuild

Dockerfile diff (commit b3acd04): one comment line and `LABEL org.swcstudio.substrate.keep="true"`
after `FROM`. Nothing else changed since 890f318 (03-01).

D-03 gate immediately before: `df --output=avail -B1 /` → 192375791616 (≥ 10737418240) → `d03_gate=pass`.

```
docker buildx build --load --pull --build-context ultrathink=/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0 -t substrate-sandbox:0.1 /root/src/repos/agent-substrate/infra/sandbox
```

Observed: the only resolved FROM was
`docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
— **identical to 03-01's base digest**. Build log ends `#12 DONE 365.7s`, 0 `ERROR` lines; bun
checksum step printed `1.4.0`, sandbox-agent step printed `sandbox-agent 0.4.2`. (The wrapper
pipeline reported 141 — SIGPIPE from the `grep | head` display filter, not the build.)

| key | value |
|---|---|
| image id / manifest-list digest | `sha256:3c72e6c37d646df9347181311a97e63c2231ba3357a79585adafc14eaad27724` |
| RepoDigests | `substrate-sandbox@sha256:3c72e6c37d646df9347181311a97e63c2231ba3357a79585adafc14eaad27724` |
| size | 181084860 bytes (03-01: 181055374) |
| created | 2026-09-28T02:34:03.591069503Z |
| labels | `{"org.swcstudio.substrate.keep":"true"}` |
| ENTRYPOINT / WORKDIR | `["sandbox-agent"]` / `/work` |
| disk before / after | 192375791616 / 191370969088 |
| base after build | `docker image inspect node:24-bookworm-slim` → No such image (containerd store did not keep it tagged) |

The image id differs from 03-01's `sha256:2063de59…` because of the added LABEL (and a fresh apt/gh layer).

Content check (`docker run --rm --network none --entrypoint sh substrate-sandbox:0.1 -c …`, run_exit=0):

```
node=v24.21.0
bun=1.4.0
git=git version 2.39.5
gh=gh version 2.101.0 (2026-09-15)
sandbox_agent=sandbox-agent 0.4.2
pwd=/work
plugin=.claude-plugin .gitignore .muse-plugin .omp-plugin CHANGELOG.md CODE_OF_CONDUCT.md CONTRIBUTING.md LICENSE README.md SECURITY.md bin bun.lock commands docs hooks hosts node_modules package.json scripts skills src tsconfig.json
```

Same versions as 03-01; no .claude/.planning/.hermes/issues/sessions/.github in /opt/claude-ultrathink.

## Task 2 — prune exemption and sandbox proof

Cron diff (live file vs the 0600 snapshot):

```
-29 2 * * * root docker image prune -af --filter "until=24h" > /dev/null 2>&1
+29 2 * * * root docker image prune -af --filter "until=24h" --filter "label!=org.swcstudio.substrate.keep=true" > /dev/null 2>&1
```

After: one line, `644 root root`, 129 bytes, sha256 `d68e95ea3ac088ae75a7bd3d2934febff3d8091f2f10a7ea96fe40ce58a37185`;
cron active (it re-reads changed /etc/cron.d files itself). The prune was not run.

Filter semantics: `docker image prune --help` lists `--filter` only; the Docker CLI reference
(https://docs.docker.com/reference/cli/docker/image/prune/#filter) states "Multiple filters with
**different keys** are combined using AND logic. An image must satisfy all filter conditions to be
pruned", and `label!=<key>=<value>` "removes images without the specified labels". `until` and
`label!` are different keys, so the cron prunes only images older than 24 h **and** without
keep=true; substrate-sandbox:0.1 never satisfies the second condition. Every other image is pruned
exactly as before.

Provider proof — throwaway `/tmp/03-11-proof.ts` (deleted) run as `sudo HOME=/root /usr/bin/node`,
importing `substrateDocker` from packages/host/src/sandbox-provider.ts with graph id
`ut-g5proof-189763f6`, worktree `/var/lib/substrate/worktrees/ut-g5proof-189763f6` (empty dir, 0700,
created for the proof), `network: "published_loopback"` (the live unit's `SUBSTRATE_SANDBOX_NET`) and
the unit's read-only node_modules bind; create → getUrl → getToken → GET /v1/health → destroy. No graph
registered, no task opened, dispatch untouched. Token never printed.

```
sandbox_id=767019d0e387
sandbox_url=http://127.0.0.1:32768
health_body={"status":"ok"}
health_with_token=200
health_without_token=401
destroyed=yes
proof_exit=0
containers_after=0
```

Cleanup: 0 containers with label `substrate.graph_id` (any value); the proof worktree (plus the empty
`node_modules` mountpoint Docker created in it) removed; not registered in `git worktree list`;
127.0.0.1:32768 no longer listening; script deleted. substrate-host untouched (ActiveEnterTimestamp
still Sat 2026-09-26 15:09:58 UTC); substrate-desktop still Up, recruitment-desktop still Exited (137)
as before — neither touched.

## Gates

No TypeScript, Python or test file changed (the Dockerfile is not read by the bun suite or tsc), so the
root bun suite (640/0) and tsc (0) were not re-run; 03-VERIFICATION's latest gates stand.

## Notes

- None from the plan. The base was absent before 03-11 (route (b)) and is also absent after
  the build (containerd store), so route (b)'s base line is a no-op today.

## Commits

- 5a83439 docs(03-11): gap-closure plan
- b3acd04 feat(03-11): label the sandbox image org.swcstudio.substrate.keep=true
- (this summary) docs(03-11): summary

## Next

G5's `missing` items are both done; re-verification of truth 6 (`docker image inspect substrate-sandbox:0.1`)
now passes. 03-10 may be revived later without a rebuild.
