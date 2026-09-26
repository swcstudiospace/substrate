---
phase: 04-skills
plan: 03
subsystem: infra
tags: [skills, propose, git, gh, github, ledger, mcp, http, auth, d-09, d-18, d-19, sc-2, sc-4, w1, w2, w4, i19, tracer]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md (bun 338/0, tsc-exit=0), /var/lib/substrate/phase4-baseline (RESTORE.md index, RESTORE.d per plan); 04-02 redactSkillContent/scanSkillFiles (redact.ts), swcstudiospace/agent-skills (PRIVATE, main @ 3ac8572), /var/lib/substrate/skills/mirror.git (main only), /root/agent-skills clean checkout
  - phase: 03-lane-a
    provides: 03-07 hostfns.ts shape (pure argv builders + injected Runner, execFileRunner, originMatches, prUrlOf, recorded-URL idempotence); key=value tracer evidence with one Gaps heading
provides:
  - types.ts — SURFACES gains "docs-scraper" (after "herdr"), EVENT_KINDS gains "skill.propose" (after "complete")
  - skills/frontmatter.ts — parseFrontmatter (Bun.YAML; null without a fence, on bad YAML or a non-mapping)
  - skills/propose.ts — LIBRARY_REPO/LIBRARY_URL/SKILLS_STATE/MIRROR/PROPOSE_ROOT/LOCK_DIR/CONTENT_LOCKS/LEDGER/SKILL_NAME_RE/ROUTE_MAX_BYTES/CLI_MAX_BYTES, ProposeInput (remove), ProposeOptions (mode, dryRun, reopen, ledgerPath, stateDir and lockWaitMs test seams), ProposeResult, ProposeRefused (findings), ProposeFailed, validateProposal, writeTree, branchName, the argv builders, prTitle/prBody, prUrlOf, originMatches, Runner/execFileRunner, proposeSkill, createSkillProposer/SkillProposer
  - skills/propose-auth.ts — PROPOSE_KEY_FILE (env SUBSTRATE_PROPOSE_KEY_FILE), PROPOSE_KEY_HEADER x-substrate-propose-key, readProposeKey (per call), proposeAllowed (timingSafeEqual)
  - service.ts — Substrate.proposeSkill (ROUTE_MAX_BYTES, overlay, no doc examples) + fail-open skill.propose event; stores.skills seam
  - mcp.ts — skills_propose; createMcpServer(substrate, callerSurface, { proposeAllowed }) (default false)
  - server.ts — POST /skills/propose (401 before the body, 400/413/502), BodyTooLargeError → 413 on every route, createHttpServer(…, { readProposeKey }) seam, /mcp sessions carry proposeAllowed
  - cli — `substrate skills propose --dir … [--allow-doc-examples pem,jwt] [--replace] [--reopen] [--dry-run]` (in-process, key=value output, exit 0/1)
  - packages/miner/skills/substrate-skill-miner/SKILL.md — the Hermes miner's skill (tracer payload)
  - tracer PR https://github.com/swcstudiospace/agent-skills/pull/1 (OPEN, base main, files substrate-skill-miner/SKILL.md) for 04-04
  - host state — /var/lib/substrate/skills/{proposals.jsonl (0600), propose/, locks/, propose.key (0600, 64 hex)}; RESTORE.d/04-03.md and its RESTORE.md index row
  - 04-03-TRACER.md — tracer, ledger, overlay dry run, route and tool evidence
affects: [04-04, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11, 04-12]

actuals:
  tokens: 28411      # chars/4 over the 7a498ef..73415c0 diff (14 files, +2174/-14)
  tasks: 2
  commits: 4         # git rev-list --count 7a498ef0b22fe48f2063b2ebf23031ba28164892..HEAD (before this SUMMARY commit)
plan_head_before: 7a498ef0b22fe48f2063b2ebf23031ba28164892

tech-stack:
  added: []
  patterns:
    - "Proposal idempotence is a local append-only ledger keyed by content hash plus strongly consistent gh reads (pr view by URL, pr list --head by branch); GitHub's search index is never consulted"
    - "An owner-closed proposal is remembered (ledger state closed) and answered declined; only an explicit operator flag (CLI --reopen) proposes it again"
    - "Overlay is the default tree semantics: a proposal rewrites the files it names on top of origin/main, deletes only an explicit remove list, and only the CLI may replace a whole tree"
    - "Credential-spending routes need more than local anonymity: a bearer surface or a root-only key sent as a header, read per request and compared in constant time; the check runs before the body is read"
    - "Directory locks hold the owner PID; a dead PID is reclaimed, a live one is waited for (20 s) and then fails as busy"

key-files:
  created:
    - packages/mcp-server/src/skills/frontmatter.ts
    - packages/mcp-server/src/skills/propose.ts
    - packages/mcp-server/src/skills/propose.test.ts
    - packages/mcp-server/src/skills/propose-auth.ts
    - packages/miner/skills/substrate-skill-miner/SKILL.md
    - .planning/phases/04-skills/04-03-TRACER.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-03.md (host, not in git)
    - /var/lib/substrate/skills/{proposals.jsonl, propose/, locks/, propose.key} (host, not in git)
  modified:
    - packages/mcp-server/src/types.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/mcp.test.ts
    - packages/mcp-server/src/server.ts
    - packages/mcp-server/src/server.test.ts
    - packages/cli/src/index.ts
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-03)

key-decisions:
  - "ProposeOptions gained two test seams beyond the plan's list: stateDir (mirror, propose root, locks and ledger under one tmp dir) and lockWaitMs (so the 20 s busy path is tested in 150 ms). Production passes neither."
  - "A dry run takes no content lock and reads no ledger (it makes no gh call and writes no ledger line); it still takes the mirror lock for the fetch."
  - "A lock directory without a PID file is reclaimed only once it is older than the wait (20 s): the gap between mkdir and the PID write is never mistaken for a dead owner."
  - "The 502 body is redact(message).slice(0, 400); ProposeFailed itself carries at most 400 characters of output, redacted over the whole output before the tail is cut, so a token split by the cut cannot survive."
  - "The PR rationale is passed through redactSkillContent before it goes into the body; session_id and graph_id are put on one line and capped at 200 characters."
  - "execFileRunner adds GIT_TERMINAL_PROMPT=0 and GH_PROMPT_DISABLED=1 to hostfns' environment, so a missing credential fails instead of waiting for a prompt until the 120 s timeout."

patterns-established:
  - "Host clients (04-07 bridge, 04-08 Omp, 04-09 Grok) read /var/lib/substrate/skills/propose.key at request time and send it as x-substrate-propose-key; unreadable key or 401 → queue; 413 and declined are final"

requirements-completed: []

coverage:
  - id: D1
    description: "D-09/D-18/D-19 propose core:
      - every guard before the first Runner call: name regex, surface in SURFACES, relative paths (no absolute, backslash, .., dot-segment, __pycache__, .pyc), SKILL.md with frontmatter name = dir and a non-empty description, no NUL, byte cap naming the limit, remove never SKILL.md and never also in files, scanSkillFiles findings (file, line, rule; never the value);
      - content_sha256 over mode, sorted redacted files and sorted removals;
      - overlay / remove / replace tree writes confined to <clone>/<name>/;
      - exact argv builders with no force/search flag and no colon refspec;
      - ledger: OPEN → existing, CLOSED → declined (ledger closed) unless reopen, MERGED → normal path (unchanged when main holds it), pushed without PR → pr list --head → existing or create without a second push, unchanged → no push and no ledger line;
      - origin check before push, ≤ 400 redacted characters on failure, clone removed on every path, dry run counts;
      - locks: mirror lock released after the fetch, content lock held through the last ledger write, dead PID reclaimed, busy after the wait, two concurrent identical proposals → one create."
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/skills/propose.test.ts: 55 pass, 0 fail (RED committed first in a924226)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Tracer near end (SC-4, D-09): the miner's SKILL.md went CLI → validate → redact → mirror clone → branch skill/claude-code/substrate-skill-miner-20260926T071325459Z-4c1c → push → gh pr create: PR #1 OPEN on main with the one file; event 202; an immediate re-run returned existing with the same URL (763 ms); ledger 2 lines (pushed, opened), mode 600; the overlay dry run of parallel-stock-deep-research (4 tracked files) changed 1 and kept 3."
    verification:
      - kind: integration
        ref: "04-03-TRACER.md; Task 1 <automated> verify (/tmp/04-03/t1-verify.sh under /bin/bash): exit 0, run again after Task 2: exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "W4 caller boundary: POST /skills/propose and skills_propose need a bearer surface or the propose key; anonymous → 401 before the body is read (a 2 MB body too) and an isError tool refusal naming the host propose key, with no service call; 400 shape/surface/remove/findings, 413 over 1 MB, 502 on git/gh failure, GET 404; the service call uses the route cap, overlay and no doc examples and emits skill.propose fail-open."
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/{service,mcp,server}.test.ts: 81 pass, 0 fail (RED committed first in b551351)"
        status: pass
      - kind: integration
        ref: "04-03-TRACER.md route keys: live anonymous route 401 and tool isError, keyed Bad_Name 400, ghp_ shape 400 rule github, 1.1 MB 413, tracer re-propose 200 existing PR #1 through the systemd service's gh; 7410 bound to 127.0.0.1 only; key 0600, 64 hex; Task 2 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Root suite and tsc two-sided green against 04-BASELINE.md with more passes than agent-substrate-pass."
    verification:
      - kind: other
        ref: "bun test: 425 pass, 0 fail (baseline 338; 351 after 04-02); no failing ids on either side; tsc-exit=0, the baseline set"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 03: Skills propose core, CLI tracer, route and MCP tool Summary

**One git path now turns a skill directory into a pull request on the private library:**
- `substrate skills propose --dir`, `POST /skills/propose` and the MCP tool `skills_propose` all end in `proposeSkill`.
- Every guard and the skill redactor run before the first git or gh call. The proposal is overlaid on the skill as it is on `origin/main` in a shared clone of the local mirror, then a fresh `skill/<surface>/<name>-<ts>-<hex>` branch is pushed and `gh pr create` runs.
- The Hermes miner's own SKILL.md travelled this path to [agent-skills#1](https://github.com/swcstudiospace/agent-skills/pull/1), which is OPEN on `main` with one file.
- Proposing it again, from the CLI (763 ms) and through the keyed route (782 ms), found the same PR through the ledger and `gh pr view`. Neither pushed anything.
- Anonymous callers are refused before anything reaches git: 401 on the route and an error on the tool. That covers a rivet VM guest's MCP session too.

## Performance

- **Duration:** 15 min (07:05:38Z–07:20Z, a few minutes after the 07:02 reboot; the host load average was about 1)
- **Started:** 2026-09-26T07:05:38Z
- **Completed:** 2026-09-26T07:20Z
- **Tasks:** 2 (both TDD: RED test commit, then the implementation)
- **Files modified:** 14 in the repo, plus this SUMMARY. On the host: the propose key, the ledger, the state dirs and RESTORE.d/04-03.md. On GitHub: PR #1.

## Baselines (two-sided, against 04-BASELINE.md)

| Suite | 04-BASELINE (44bad2d) | After 04-02 (c2f0b31) | After Task 1 (464b151) | After Task 2 (73415c0) |
|---|---|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail | 351 pass, 0 fail | 406 pass, 0 fail | 425 pass, 0 fail |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |

No failing-id set differs from the baseline in either direction.

## Accomplishments

- **Propose core (`skills/propose.ts`, D-09, W1, W2, W9, I10, I19).**
  - `validateProposal` checks, in order: name, surface, paths, text, byte cap, SKILL.md frontmatter, removals, then `scanSkillFiles`. Findings refuse and carry `{file, line, rule}` only.
  - The content hash covers the mode, the redacted files and the removals, so the same proposal always hashes the same.
  - `writeTree` writes only inside `<clone>/<name>/`. It refuses traversal and symlinked parents, and only `replace` empties the skill first.
  - Order of steps: per-content lock → ledger → mirror lock / fetch / unlock → `clone --shared --no-checkout` → `set-url` to the GitHub URL → `checkout -b … origin/main` → overlay → `add -- <name>` → `diff --cached --quiet` → commit (`substrate skills`, message with `skill-content-sha256:` and `Refs SPE-2734`) → `originMatches` → push → ledger `pushed` → `gh pr create` → ledger `opened`. The clone is removed and the locks released in `finally`.
  - The file has no quoted force, search or `in:body` literal and no import from the host package; the Task 1 gate greps for all three.
- **Ledger** `/var/lib/substrate/skills/proposals.jsonl` (0600, append-only, last line wins). Replies from it:
  - OPEN → `existing`.
  - CLOSED → `declined`, recorded as `closed`. Only the CLI's `--reopen` proposes it again.
  - MERGED → the normal path runs.
  - Pushed without a PR → `gh pr list --head` finds it, or `gh pr create --head` runs for that branch. It is never pushed a second time.
- **CLI.**
  - Reads the dir with `lstat`: a symlink, a special file, non-UTF-8 content or more than 64 MB refuses the whole dir and names the cause.
  - Defaults: name is the basename, surface is `claude-code`.
  - `--allow-doc-examples` accepts only `pem` and `jwt`. The other flags are `--replace`, `--reopen` and `--dry-run`.
  - Prints key=value lines and `event_status` from the `skill.propose` POST. Exits 1 on a refusal or failure.
- **Caller check (`propose-auth.ts`, W4).** A bearer surface, or the header `x-substrate-propose-key` equal to the 0600 key file. The file is read per request and compared with `timingSafeEqual`.
- **Service.** `Substrate.proposeSkill` always passes the 1 MB cap and `overlay`, and never allows doc examples. It emits one `skill.propose` event `{name, status, pr_url, content_sha256}` through `.catch(() => undefined)`.
- **MCP tool.** `skills_propose` checks `proposeAllowed` first, then `ownerSurface`. Refusals and failures come back as `isError` JSON, and findings never carry a value.
- **HTTP route.** `POST /skills/propose`:
  - 401 before `readBody`;
  - 400 on shape (`files` of strings, `remove` of strings, a known surface, string ids) and for an authenticated caller naming another surface;
  - `ProposeRefused` → 400 `{error, findings}`, `ProposeFailed` → 502 (≤ 400 characters, redacted);
  - `BodyTooLargeError` → 413 on every route;
  - `/mcp` hands each session its `proposeAllowed`.
- **Miner skill.** `substrate-skill-miner` covers:
  - its monitor inputs (`transcript <id>`, `day <date>`) and what it reads;
  - at most 3 procedures, not already in the library;
  - `skill_manage` create/edit/patch only, never a name Hermes has locally;
  - required frontmatter with `metadata.source`;
  - no secrets and no direct writes;
  - "say so and stop" when nothing is reusable.

## Task Commits

1. **Task 1: Tracer — propose one real skill end to end through the CLI**: `a924226` (test, RED), `464b151` (feat) in agent-substrate; branch `skill/claude-code/substrate-skill-miner-20260926T071325459Z-4c1c` and PR #1 in swcstudiospace/agent-skills
2. **Task 2: skills_propose MCP tool and POST /skills/propose behind the host caller check**: `b551351` (test, RED), `73415c0` (feat)

**Plan metadata:** this SUMMARY commit (docs).

## Files Created/Modified

- `packages/mcp-server/src/types.ts`: `docs-scraper` surface, `skill.propose` kind.
- `packages/mcp-server/src/skills/frontmatter.ts`, `propose.ts`, `propose.test.ts`, `propose-auth.ts`: the propose module, its tests and the caller check.
- `packages/mcp-server/src/service.ts`, `mcp.ts`, `server.ts` and their tests: `proposeSkill`, `skills_propose`, `POST /skills/propose`, the 413 mapping.
- `packages/cli/src/index.ts`: `skills propose`, docblock and usage line.
- `packages/miner/skills/substrate-skill-miner/SKILL.md`: the tracer payload and 04-07's cron skill.
- `.planning/phases/04-skills/04-03-TRACER.md`: the evidence.
- Host only: `/var/lib/substrate/skills/{proposals.jsonl, propose/, locks/, propose.key}`, `/var/lib/substrate/phase4-baseline/{RESTORE.d/04-03.md, RESTORE.md row}`.

## Decisions Made

See key-decisions. None of them changes a D-01..D-21 contract or an `<interfaces>` shape.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The Task 1 gate counted a comment as a host import**
- **Found during:** Task 1 verify (first run exited 1 at `grep -c 'host/src'`)
- **Issue:** propose.ts's header comment named `packages/host/src/hostfns.ts` as the analog. The gate counts the string, not an import.
- **Fix:** the comment now says "the host package's hostfns.ts". There is still no import.
- **Files modified:** packages/mcp-server/src/skills/propose.ts
- **Verification:** Task 1 verify exit 0
- **Commit:** 464b151

**2. [Rule 1 - Bug] A test type error after the RED commit**
- **Found during:** Task 2 (tsc after GREEN)
- **Issue:** `(await res.json()).error` in server.test.ts is `unknown` under tsc (TS2571). bun ran it anyway.
- **Fix:** added a type assertion on that one line. The assertion is unchanged.
- **Files modified:** packages/mcp-server/src/server.test.ts
- **Verification:** tsc-exit=0; server tests green
- **Commit:** 73415c0

**3. [Rule 2 - Missing critical] Output tail redaction order**
- **Found during:** Task 1 (writing `tail()`)
- **Issue:** hostfns' `tail()` cuts the last 400 characters, then redacts. A token cut in half by the slice would no longer match its pattern and would leak its remainder.
- **Fix:** propose.ts redacts the whole output first, then cuts. The failing-step test asserts the message never carries the token and keeps at most 400 characters of output. It does not isolate the ordering, because its token sits inside the last 400 characters.
- **Files modified:** packages/mcp-server/src/skills/propose.ts
- **Verification:** propose tests 55/55
- **Commit:** 464b151

---

**Total deviations:** 3 auto-fixed (Rule 1: 1, Rule 2: 1, Rule 3: 1).
**Impact on plan:** No contract changed.

## Issues Encountered

- The shell's `date` is a builtin that ignores `%3N` and prints nanoseconds. The tracer timings were computed as nanosecond differences and recorded in ms (5728 and 763); 04-03-TRACER.md states this.
- Task 1's live state (ledger, `propose/`, `locks/`, PR #1) was created before RESTORE.d/04-03.md existed. The plan orders the route file in Task 2, before the key. Task 1 created only new files and edited no existing live file. The route file now covers all of that state.
- The PR #1 body predates a cosmetic fix (a blank line after `## Redacted spans`, in 464b151 before the commit). The hash and every other line are unchanged.
- The skill redactor's known over-redaction (04-02-SCAN Gaps) applies to every propose. `Authorization: 'Bearer ' + key` scheme words and `password: str` annotations are rewritten, and the `Redacted spans` list names them. Neither the tracer skill nor the overlay check hit it (0 redactions). 04-10's docs exports will.
- Both `<automated>` blocks were extracted verbatim to `/tmp/04-03/t{1,2}-verify.sh` and run under `/bin/bash`. Each exited 0, and t1 was re-run after Task 2: exit 0.

## Threat Flags

None beyond the plan's register. Observed:
- **T-04-03-01:** argv builders are pinned. No force or search flag and no colon refspec appear, and the push ran only after `originMatches`. Port 7410 is bound to 127.0.0.1 only.
- **T-04-03-02:** both the anonymous route and the anonymous tool were refused live. The key file is 0600 and was never printed.
- **T-04-03-03:** traversal and symlink refusals are tested.
- **T-04-03-04:** findings never carry values: the live `ghp_` shape was absent from the reply. The evidence contains no token shape.
- **T-04-03-05:** the overlay dry run showed `diff_deleted=0`.
- **T-04-03-06:** re-propose returned `existing` twice with no push.
- **T-04-03-07:** propose took 5.7 s, re-propose 0.8 s.
- **T-04-03-08:** the `skill.propose` event was accepted (202). The ledger and the branch name carry the surface.

## User Setup Required

None. The owner merges or closes PR #1 in 04-04 (D-16).

## Next Phase Readiness

- **04-04:** PR #1 (`substrate-skill-miner/SKILL.md`, OPEN, base main) is ready for the owner's merge, the sync timer and the projector. After the merge, the mirror's next fetch brings the content onto `main`, and an identical re-propose then ends `unchanged`.
- **04-07, 04-08 and 04-09 host clients:**
  - Read `/var/lib/substrate/skills/propose.key` per request and send it as `x-substrate-propose-key`.
  - Treat 401 or an unreadable key as unreachable (queue).
  - Treat 413 and `declined` as final.
  - The reply shape is the interfaces block's, and `pr_number` and `branch` are present on `opened` and `existing`.
- **Configured tokens:** if `SUBSTRATE_TOKEN_*` lines are ever configured, the global bearer check refuses anonymous callers before the key check, so key-only clients would need a token too. Today there are none (TRACER Gaps).
- **04-10:** calls the CLI with `--replace` and `--allow-doc-examples pem,jwt`. Only the CLI accepts either.
- **Untouched:** STATE.md, ROADMAP.md, `.planning/config.json`, `.planning/state.json` and `issues/` are unstaged.

## Self-Check: PASSED

- FOUND: packages/mcp-server/src/skills/{frontmatter,propose,propose-auth}.ts, propose.test.ts, packages/miner/skills/substrate-skill-miner/SKILL.md, .planning/phases/04-skills/04-03-TRACER.md
- FOUND: /var/lib/substrate/phase4-baseline/RESTORE.d/04-03.md (names propose.key), /var/lib/substrate/skills/propose.key (600), proposals.jsonl (600, 2 lines for the tracer hash)
- FOUND: commits a924226, 464b151, b551351, 73415c0 (agent-substrate); PR swcstudiospace/agent-skills#1 OPEN
- Task 1 and Task 2 `<automated>` verifies: exit 0 under /bin/bash; substrate-mcp active, /healthz 200
