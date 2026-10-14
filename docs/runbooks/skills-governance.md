# Runbook — approval-gated skills projection

| | |
| --- | --- |
| Scope | The projector half of skills governance: `packages/projector/src/skills-governance.ts`, run by `substrate-skills-sync.service` (and `bun packages/projector/src/skills.ts`) |
| Flag | `SUBSTRATE_SKILLS_GOVERNANCE=off\|report\|enforce`, default `off` |
| Reads | `GET /skills?state=approved` on the substrate (the registry and `skills_approve` are the server half; see `docs/skills-propose.md`) |
| Untouched | The library checkout, every skill root's existing links and real directories, `docs/event-vocabulary.md` |

## What it is

Today a skill merged to agent-skills `main` is linked into the agent roots within
five minutes: "approved" means "merged". With the registry in place the
projector can consult it. Three modes, read from the projector's own
environment (`SUBSTRATE_SKILLS_GOVERNANCE` in the sync unit's environment file —
the substrate server reads the same variable name for its registry writes, so
set it deliberately on each side):

| Mode | Network | Links | Warning |
| --- | --- | --- | --- |
| `off` | none | exactly as before | none |
| `report` | one bounded `GET /skills?state=approved` per run | every library skill, exactly as before | one deduped `skills.sync` warning |
| `enforce` | the same fetch | NEW links only for approved skills | the same warning, plus one when no approved list exists |

An unset, blank or unrecognised value is `off`; an unrecognised value prints one
`[projector] SUBSTRATE_SKILLS_GOVERNANCE=… is not off, report or enforce` line.

## Procedure

1. **Soak in `report`.** Put `SUBSTRATE_SKILLS_GOVERNANCE=report` in the
   environment file of `substrate-skills-sync.service` and let a few timer ticks
   run (`journalctl -u substrate-skills-sync -n 40`). Nothing is linked or
   unlinked differently. The unit must hold a surface token
   (`SUBSTRATE_TOKEN_SUBSTRATE`, or the generic `SUBSTRATE_TOKEN`; a comma list
   contributes its first entry). With no token the projector makes no call and
   logs `no surface token`.
2. **Read the warning.** Query the event store for `kind=warning` with
   `payload.action = skills.sync` and `payload.reason = unapproved`:
   `count` is how many library skills are not approved, `names` the first 20 in
   name order (names only; `count` carries the rest). It is sent once per
   distinct set of names and again every 24 hours while the gap stands (a
   clock that steps backwards also re-sends it). The warning is posted with the
   same bearer as the fetch, as surface `substrate` (the unit's token is that
   surface's token; the server refuses it under any other surface name). The
   projector's existing per-root skip warnings (`real-dir-differs`,
   `foreign-link`, `stray-real-dir`) are posted the same way when the unit token
   is the credential: surface `substrate`, with the root's id in `payload.root`
   and its surface in `payload.root_surface`; with only a generic agent token
   they go out under the root's own surface as before. When the server cut its list at 500 the reason is
   `approved-list-truncated` instead (see Limits). When the fetch fails the
   run logs `approved list unavailable (…)` and uses the cached
   `approved.json` if one exists: in `report` that stale set still produces the
   warning (computed from the cache, not from the live registry); with no usable
   cache `report` has no approved set to compare against and sends no warning.
3. **Grandfather what is already on `main`.** Before `enforce`, every skill that
   should keep being linked must be approved, or new links for it stop. For each
   name in the warning (and in `ls /root/agent-skills`), approve it once with the
   operator-only `skills_approve` (MCP tool or `POST /skills/approve`) against
   the PR that merged it. Re-run until the `unapproved` warning stops, i.e.
   `count` reaches 0.
4. **Switch to `enforce`.** Set `SUBSTRATE_SKILLS_GOVERNANCE=enforce`. The next
   tick still exits 0 and prints `[projector] <root> held link-new <name> (not
   approved)` for each held new link. `bun packages/projector/src/skills.ts
   --check` shows what would be linked now (only approved skills) and writes
   nothing.
5. **Approve new skills as they arrive.** A newly merged skill is linked on the
   first tick after it is approved. Until then it appears in the `unapproved`
   warning.

## What `enforce` does

- Holds back, for skills that are not approved, the three actions that would put
  a library link under a name: a missing link (`link-new`), the replacement of a
  real directory byte-identical to the library copy (`backup-then-link`), and the
  repointing of an existing link into the exports dir at the library copy
  (`repoint`). A held `repoint` leaves the existing exports link where it is.
- Keeps every other action: skip-warns, and the flag-driven removal of the
  projector's own links in a disabled root, run as before; every action for an
  approved skill runs as before.
- Uses the last approved list the projector saved when the fetch fails:
  `/var/lib/substrate/skills/approved.json` (beside `projector-warned.json`),
  written after every successful fetch in `report` and `enforce`, mode 0600, tmp
  + rename. A cache that is missing, larger than 64 KiB, of another version, has
  more than 500 names or any name outside the library name rule is ignored whole.
- With no usable list at all, treats nothing as approved: no NEW link is made,
  existing links are left alone, and one `reason: approved-list-unavailable`
  warning is sent (again after 24 hours if it persists).
- Never blocks the sync tick on the fetch: the call is cut after 3 s and the
  `/docs/merge-trigger` refresh runs as before.

## What `enforce` does NOT do

- It never unlinks or deletes anything. A skill that is already linked and is
  later declined, retired or never approved keeps its link in every root and its
  directory in the library; it only appears in the `unapproved` warning. Removing
  such a link is an operator step (`rm <root>/<name>`, or the root's disable flag).
- It does not compare content. Approval is by name; a later PR that changes an
  approved skill's files is linked as soon as the sync fast-forwards.
- It does not gate the library checkout: `skills-sync` still fast-forwards
  `/root/agent-skills` to `origin/main` on every tick.
- It does not protect against a host that already holds a real directory or link:
  those are the existing `real-dir-differs` / `foreign-link` cases.

## Rollback

Set `SUBSTRATE_SKILLS_GOVERNANCE=off` (or remove the line) in the unit's
environment file; the next tick is the old projector with no fetch. This
restores the linking behaviour for skills that were held; it does not remove
`approved.json` or `governance-warned.json` (harmless, safe to delete), and it
changes nothing about the registry on the server.

## Limits

- The approved list is whatever the server returned within 3 s; a server that
  returns fewer than 500 entries with `truncated: false` is trusted as complete.
- A list the server cut (`truncated: true`, or more than 500 entries) is used
  and cached as received, and the cut is remembered in `approved.json`. Approved
  skills beyond the cut are counted as not approved: in `enforce` their new
  links stay held (fail-closed for NEW links; existing links are untouched), and
  the warning's reason is `approved-list-truncated` with `truncated: true` in
  the payload, in `report` and `enforce` alike. The projector cannot fetch the
  rest; the fix is fewer approved skills than the cap or an operator decision on
  the server side.
- Dedupe state lives in `/var/lib/substrate/skills/governance-warned.json`; a
  warning the substrate refused is retried on the next run.
- The fetch and the warning post need a surface token the projector unit
  already carries for `/docs/merge-trigger` (`SUBSTRATE_TOKEN_SUBSTRATE`, then
  `SUBSTRATE_TOKEN`; first entry of a list); the projector never logs its value.
