# 04-03 skills tracer evidence (near end)

Recorded from observed output only.

## Restart after the contract change (types.ts)

```
sudo systemctl restart substrate-mcp
curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:7410/healthz      # polled until 200
systemctl is-active substrate-mcp
```

Observed at 07:13:20Z: `healthz=200`, `active`. `/events` accepts `skill.propose` only after this
restart (EVENT_KINDS is a closed enum validated by the running service).

tracer_skill=substrate-skill-miner
mcp_restarted_after_types=true

## Tracer: CLI propose, then an immediate identical re-propose

```
bun packages/cli/src/index.ts skills propose --dir packages/miner/skills/substrate-skill-miner \
  --surface claude-code --rationale "Phase 4 tracer: the Hermes miner's own skill (D-13)"   # run 1
bun packages/cli/src/index.ts skills propose --dir packages/miner/skills/substrate-skill-miner \
  --surface claude-code --rationale "Phase 4 tracer: the Hermes miner's own skill (D-13)"   # run 2, at once
```

Run 1 printed `status=opened`, `pr_number=1`, `redactions=0`, `event_status=202`, exit 0.
Run 2 printed `status=existing` with the same URL, branch and hash, `event_status=202`, exit 0:
the ledger line for the hash named PR #1 and `gh pr view` reported OPEN, so no clone, push or
create ran. Timings are wall clock around each CLI process (bun start-up included); the shell's
`date` builtin printed nanoseconds, so the recorded values are the nanosecond differences / 10^6.
A dry run of the same dir just before (07:12Z) printed `status=dry_run`, the same hash,
`diff_added=1`, `diff_changed=0`, `diff_deleted=0`, `event_status=none`.

propose_status=opened
pr_url=https://github.com/swcstudiospace/agent-skills/pull/1
pr_number=1
pr_branch=skill/claude-code/substrate-skill-miner-20260926T071325459Z-4c1c
content_sha256=99624dbbe73b81d07da6057afc123160bc69742a3e55f55c24ddb8306ef98676
propose_ms=5728
event_status=202
repropose_status=existing
repropose_pr_url=https://github.com/swcstudiospace/agent-skills/pull/1
repropose_ms=763

## Ledger

```
sudo grep -c <content_sha256> /var/lib/substrate/skills/proposals.jsonl
sudo stat -c %a /var/lib/substrate/skills/proposals.jsonl
```

Two lines for the hash, `state` `pushed` (07:13:27.835Z, branch only) then `opened` (07:13:29.892Z,
`pr_url` …/pull/1, `pr_number` 1); the re-propose appended nothing. `propose/` and `locks/` were
empty afterwards (clone removed, content lock released; the mirror lock directory was absent).

ledger_lines_for_hash=2
ledger_mode=600

## PR read back under the service's credential path

```
env -i HOME=/root PATH=/usr/bin:/bin gh pr view https://github.com/swcstudiospace/agent-skills/pull/1 \
  --json state,baseRefName,files,headRefName
env -i HOME=/root PATH=/usr/bin:/bin gh pr view https://github.com/swcstudiospace/agent-skills/pull/1 --json title,body
```

`{"base":"main","files":["substrate-skill-miner/SKILL.md"],"head":"skill/claude-code/substrate-skill-miner-20260926T071325459Z-4c1c","state":"OPEN"}`.
Title `skill(substrate-skill-miner): proposal from claude-code`; the body carries
`skill-content-sha256: 99624dbb…f98676`, `surface: claude-code`, `tree mode: overlay`,
`removed paths: none`, the rationale and `Redacted spans` none. Branch head commit message
`skill(substrate-skill-miner): claude-code proposal` / `skill-content-sha256: …` / `Refs SPE-2734`,
author `substrate skills`.

pr_state=OPEN
pr_base=main
pr_files=substrate-skill-miner/SKILL.md

## Overlay dry run (W2, no PR)

```
O=/tmp/04-03-overlay
mkdir -p $O/parallel-stock-deep-research
cp /root/agent-skills/parallel-stock-deep-research/SKILL.md $O/parallel-stock-deep-research/
echo "Overlay check line (04-03 dry run)." >> $O/parallel-stock-deep-research/SKILL.md
git -C /root/agent-skills ls-files parallel-stock-deep-research | wc -l
bun packages/cli/src/index.ts skills propose --dir $O/parallel-stock-deep-research --surface claude-code --dry-run
rm -rf $O
```

The library skill has 4 tracked files; the proposal named only SKILL.md; the staged diff against
origin/main changed that one file and kept the other three (`redactions=0`, `event_status=none`,
exit 0). `/tmp/04-03-overlay` is gone, `/root/agent-skills` porcelain is empty and `propose/` is
empty.

overlay_skill=parallel-stock-deep-research
overlay_base_files=4
overlay_diff_added=0
overlay_diff_changed=1
overlay_diff_deleted=0

## Gaps

- The PR stays OPEN: merging it is the owner's step in 04-04 (D-16), which carries it through the
  sync timer and the projector.
- `propose_ms` and `repropose_ms` include bun start-up and the `/events` POST; the propose path
  itself is not timed separately. Host load was low (just after the 07:02 reboot).
- The dry run and the tracer ran from an interactive root shell, where gh may answer from the
  shell's environment rather than hosts.yml; the PR read-back above used `env -i HOME=/root`, and
  the service-path proposals (route and tool) are exercised in Task 2.
