# U5-5b — skills governance, projector half

## Files
- New `packages/projector/src/skills-governance.ts` — flag parsing, bounded fail-open `GET /skills?state=approved`, name validation, atomic 0600 `approved.json` cache, action gating, deduped warning.
- Changed `packages/projector/src/skills.ts` — `ProjectOptions.governance?` (optional), `defaultOptions()` reads it from the env, `planFor` is async and consults governance, `project()` reports it, `--check` awaits the plan. Docblock line added.
- New `packages/projector/src/skills-governance.test.ts`.
- New `docs/runbooks/skills-governance.md`; `.planning/uplift-5/env-notes/S5b.md`; this file.
- `skills-sync.ts` and `scripts/skills-sync-smoke.ts` unchanged: skills-sync reaches governance through `defaultOptions()`; the smoke builds `ProjectOptions` without `governance`, which means off.

## Flag and behaviour
`SUBSTRATE_SKILLS_GOVERNANCE=off|report|enforce`, default `off` (invalid value => off plus one stdout line).
- `off` / absent option: no fetch, no file I/O, no extra output; parity test compares output with a run that has no governance option.
- `report`: one fetch (3 s deadline passed to `fetch`, body read under the same signal, body capped at 512 KiB while reading); plan is untouched; one `warning` `{action:"skills.sync", component:"skills-projector", reason:"unapproved", mode, count, names(<=20, sorted)}` through the existing `emitWarning` (surface `substrate`). Dedupe: `governance-warned.json` keyed by reason + digest of the name set; re-sent after 24 h or when the set changes; recorded only after the substrate accepted it. Cache is also written in report (warms the first enforce).
- `enforce`: the planner's `link-new`, `backup-then-link` and `repoint` actions for names not in the approved set are dropped (held `repoint` leaves the existing exports link in place); `skip-warn`, `remove-own-link` and every action for an approved name pass through; nothing is added. Fetch failure => cached set; no cache (missing/oversized/corrupt/wrong version/invalid name) => nothing approved => no new links, existing untouched, one `reason:"approved-list-unavailable"` warning.
- Truncated list (`truncated:true` or >500 entries): used and cached as received, the cut stored as `truncated` in `approved.json`; approved skills beyond the cut count as unapproved (enforce: new links held) and the warning reason is `approved-list-truncated` with `truncated:true` (report and enforce). Warning reasons: `unapproved`, `approved-list-truncated`, `approved-list-unavailable`.
- A 200 body that is not JSON is reported as `skills answer malformed` (not `skills unreachable`).
- Warning dedupe treats a timestamp in the future (clock stepped back) as stale and re-sends.
- `--check` fetches but never writes the cache, warned-state or warnings.
- Server names are checked with `SKILL_NAME_RE` and dropped when invalid; a response without a `skills` array is malformed (not "empty approval"); more than 500 entries keep 500 and set `truncated`. Membership is by `Set`.

## Deviations from the brief
- Gating filters the planner's actions instead of passing `libraryNames ∩ approved` as `names`: `plan()` uses the name set for Grok's `stray-real-dir` check and exports repoints, so a smaller list would raise false warnings. Effect on links is the one asked for (unapproved skills are not newly linked). `backup-then-link` and `repoint` are held as well as `link-new`: both put a library link under a name that held a real directory / an exports link.
- Token resolution lives in `skills-governance.ts` as `resolveSurfaceToken` (skills-sync imports skills.ts, so importing `refreshTarget` would be circular); first entry of list-valued variables, `SUBSTRATE_TOKEN_SUBSTRATE` then `SUBSTRATE_TOKEN`. `postWarning` in skills.ts now uses it too (and takes optional `env`/`fetchImpl` test seams), so governance warnings carry the same identity as the fetch. Behaviour change for all projector events: an env that holds only the per-unit token now posts authenticated (before: anonymous), and a comma list posts its first entry (before: the whole list).
- Surface attribution: the unit token is the `substrate` host-job surface token and the server's `attributedSurface` answers 403 to it for any other surface. `postWarning` therefore posts as surface `substrate` when `SUBSTRATE_TOKEN_SUBSTRATE` is set (`usesHostJobToken`), moving the root's surface to `payload.root_surface` (root id stays in `payload.root`); governance warnings already used `substrate` and carry no `root_surface`. With only the generic `SUBSTRATE_TOKEN` (or no token) events go out unchanged under their root's surface. No event-sources row pins the per-root skip warnings (no `payload.action`), so no vocabulary row or generated table changed. Tests use a fake `POST /events` that calls the real `attributedSurface`.

## Tests (`bun test packages/projector/src/skills-governance.test.ts`)
Flag parsing and token precedence; off makes no fetch/files and equals the no-option run; report projects all, one names-only warning, fail-open on error/503/missing field/non-JSON, no token => no fetch, hung fetch cut at deadline, oversized body refused, <=20 names with full count; dedupe (same set silent, renotify after 24 h, changed set immediate, refused post retried) and unwritable state non-fatal; enforce links approved only, already-linked unapproved skill keeps link/library/other links, gate removes only new-link actions, mirrored real dir not replaced and no stray warning, `--check` writes nothing; cache atomic 0600 without temp leftovers, cache fallback, no cache => fail closed once, corrupt-cache matrix, unwritable cache non-fatal; invalid/path-like/oversized names dropped, truncation at 500, hostile names reach no path.

Review round: gate holds `repoint` (unit + end-to-end, report still repoints); `postWarning` sends the unit-only token, the first entry of a comma list, unit-over-generic precedence, and the same token as the fetch; a backwards clock re-sends the warning; a cut list yields `approved-list-truncated` (live and from cache) with the cut persisted, a complete list keeps `unapproved`; non-JSON 200 => `skills answer malformed`.
## Smoke (orchestrator)
- `bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts packages/projector/src/skills-governance.test.ts` — all pass; the first two unchanged.
- Off parity by hand: `bun packages/projector/src/skills.ts --check` with the flag unset prints exactly what it printed before (no governance line).
- `bun run check:phase-close` (no new event kinds/surfaces/tokens; the file uses no `GREPTIME_`/`HINDSIGHT_` text).

## Operator steps
Follow `docs/runbooks/skills-governance.md` (soak in report, grandfather via `skills_approve`, enforce, rollback = flag off). Setting the flag in the sync unit's environment file is an operator step; no unit file changed.

## Known limits
- Approval is by name, not content hash. The projector trusts a `truncated:false` list as complete; a cut list fails closed for new links (enforce) and says so.
- The server half (`GET /skills`, registry, `skills_approve`) is a separate slice; against a server without it the fetch fails and report stays fail-open, enforce falls back to the cache then fails closed for new links.
- Nothing here was executed (edit-only wave); tests are unrun.
