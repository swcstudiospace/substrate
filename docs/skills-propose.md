# Proposing a skill

Tracked as SKILL-01 (v1.3 Phase 21). Owned by `packages/mcp-server/src/skills/propose.ts` (the git and `gh` path), `Substrate.proposeSkill` in `service.ts` (authority and events), and three doors that all end in that one method: the MCP tool `skills_propose`, `POST /skills/propose`, and `substrate skills propose`. Approval (uplift-5) is `skills/registry.ts` and `Substrate.approveSkill`, see [Approving a skill](#approving-a-skill).

Any authenticated surface can propose a skill and get a reviewable pull request on the shared skills library. The owner's merge is the gate. Nothing secret, malformed or duplicate gets through.

## The three doors

| Door | How |
|---|---|
| MCP tool | `skills_propose` over `/mcp`; the tool's input schema is the body below |
| REST route | `POST /skills/propose` with `Authorization: Bearer <surface token>` and a JSON body |
| CLI | `substrate skills propose --dir PATH [flags]`, an HTTP client of the route with `SUBSTRATE_TOKEN` |

The CLI keeps no in-process git path: that would be a second door that skips the token, the audit chain and the event. The server records the outcome; the CLI never posts an event of its own.

### The body

| Field | Type | |
|---|---|---|
| `name` | string | Lowercase letters, digits and hyphens, at most 64 characters, starting with a letter or digit |
| `files` | object | Relative path to UTF-8 text. Must contain `SKILL.md`, whose frontmatter `name` equals `name` and which has a non-empty `description` |
| `rationale` | string | Why. Goes in the PR body, capped and redacted |
| `remove` | string[] | Relative paths to delete from the skill (never `SKILL.md`, never a path also in `files`) |
| `surface` | string | Optional. Must equal the calling surface |
| `session_id`, `graph_id` | string | Optional. Recorded in the PR body and on the event |
| `dry_run` | boolean | Validate, redact, clone and count the staged diff; push nothing, call no `gh`, write no ledger line, emit no event |
| `mode` | `overlay` or `replace` | **Operator only.** Default `overlay`: the files a proposal does not name stay. `replace` makes the proposal the whole tree |
| `reopen` | boolean | **Operator only.** Propose content whose identical PR the owner closed |
| `allow_doc_examples` | `["pem","jwt"]` | **Operator only.** Documentation examples of those shapes are redacted instead of refused |

The CLI's flags map to it: `--name` (default the directory's basename), `--rationale`, `--remove a,b`, `--session`, `--graph`, `--dry-run`, and for operators `--replace`, `--reopen`, `--allow-doc-examples pem,jwt`. There is no `--surface` flag.

## Authentication and attribution

- **Only a surface token authenticates a proposal.** September's `x-substrate-propose-key` header is gone.
- **Anonymous calls are always refused**, even on a run that allows untokened callers, because a proposal spends the owner's GitHub credential. The route answers 401 before it reads the body.
- **The proposal is made as the token's surface.** That surface names the branch (`skill/<surface>/…`), the PR title and the event. A body `surface` equal to the token's, or absent, is accepted; a different one is refused 403 and never re-attributed.
- **Any authenticated surface may propose**, including swarm surfaces and the `substrate` host-job surface. There is no per-surface allowlist.
- **`mode: replace`, `reopen` and `allow_doc_examples` need an operator token** (a surface token also listed in `SUBSTRATE_OPERATOR_TOKENS`); anyone else naming one is refused 403.

## Answers

`POST /skills/propose` answers:

| Status | Meaning |
|---|---|
| 200 | The `ProposeResult` JSON: `status` (`opened`, `existing`, `unchanged`, `declined` or `dry_run`), `pr_url`, `pr_number`, `branch`, `content_sha256`, `redactions` (the redacted spans as file, line and rule), and for a dry run `diff_added`, `diff_changed`, `diff_deleted` |
| 400 | The body is malformed, or a guard refused the proposal: `{ error, findings? }`. A finding is `{ file, line, rule }`, never a value |
| 401 | No authenticated surface |
| 403 | A surface mismatch, or an operator-only option from a surface token |
| 413 | The body is over the route's cap: 1 MB here, 6 MB on the `/docs/ingest` and `/mcp` doors that share the wider ingest intake. Other routes still answer an oversize body with a generic 500 |
| 502 | A `git` or `gh` step failed or a lock stayed busy. The message is redacted and at most 400 characters |
| 503 | The audit chain could not take the record. `skills_propose` is fail-closed, so nothing is proposed |

The MCP tool returns the same result as JSON, and an `isError` reply carrying the same `{ error, findings? }` for every failure the tool itself returns (a refusal, a failed `git`/`gh` step, a missing mirror, a busy lock, an unaudited chain). That promise covers only errors returned by the tool: when the MCP audit chain cannot take the record, the transport refuses the call before the tool runs and answers a JSON-RPC error (`code -32000`), not a tool body. The CLI prints `key=value` lines (`status`, `pr_url`, `pr_number`, `branch`, `content_sha256`, `redactions`, the diff counts, one `finding=<file>:<line> <rule>` per finding) and exits 0 for the five successes and 1 for a refusal, a failure, a 401, 403, 413 or 5xx, or a server that did not answer. Its request timeout is about 180 s (`SUBSTRATE_SKILLS_TIMEOUT_MS` overrides it): a proposal runs `git fetch`, `git push` and `gh` behind the request. A CLI flag that takes a value with none given (`--remove` with nothing after it) is refused before the directory is read or anything is posted.

The public proposal cap is **1,000,000 UTF-8 bytes of the caller's JSON body**,
including escaping and caller-supplied metadata. Server-added token attribution
does not consume that budget. The CLI preflights its posted body; REST caps the
wire body; MCP checks caller arguments before attribution. A body over the cap
is refused 413 before any git work, audited under `skills_propose` with a shape
descriptor only, never the body itself. REST skills intake is also bounded at
1,000,000 wire bytes; authenticated oversize refusals are audited, and audit
denial takes precedence. Only `/docs/ingest` and `/mcp` use the separate
6,000,000-byte transport intake needed for the 5 MB docs ingest ceiling.
An oversize envelope on those doors is refused 413 before dispatch. MCP
skills caller arguments still have the 1,000,000-byte pre-attribution cap;
the wider MCP envelope does not enlarge a proposal's budget.

## What is checked, and in what order

Before any `git` or `gh` call, `validateProposal` checks the name, the surface, the rationale and the identifiers (strings, no NUL — NUL would reach `gh` argv and fail only after the branch is pushed), every path (no absolute path, backslash, `..`, dot-segment, NUL or Python bytecode), that every file is UTF-8 text without NUL, the byte cap, `SKILL.md` and its frontmatter, the removals, and then runs the skill redactor and scanner. A planted secret is **refused after redaction**, with findings that name the file, line and rule. `pem` and `jwt` documentation examples are redacted rather than refused only for an operator who passes `allow_doc_examples`.

Then `proposeSkill` runs the git path: a check that the mirror's origin still names the configured library (a changed library with a kept state directory is refused before any fetch), a per-content lock, the local ledger, a fetch of the mirror under its own lock, a shared clone, the overlay (or replacement) of the skill's tree as it is on `origin/main` — refused when a proposed file clashes with the tree (an existing directory where the file goes, or an existing file where a parent goes), naming the path — a staged diff, a commit, a check that the clone's origin is the configured library, a push of a **new branch** (never a force, never a colon refspec, never a search query), and `gh pr create`. The clone is removed and the locks released in `finally`; a lock is released only while its `pid` still names its owner, and a stale lock is taken aside and re-checked rather than deleted from under a fresh owner.

## Duplicates

Identical content, by `content_sha256` over the mode, the redacted files and the removals, is never proposed twice:

- an open PR for it answers `existing`;
- one the owner closed answers `declined`, unless an operator passes `reopen`;
- content that leaves the tree equal to `main` answers `unchanged`;
- a merged PR lets the content be proposed again.

The answers come from the local ledger plus `gh pr view` and `gh pr list --head`, which are strongly consistent, never from GitHub's search index.

## Events

An outcome is a `note` from the caller's surface with `repo` set to the configured library, and `payload` `{ action: "skill.propose", name, status, pr_url, content_sha256, redactions }` (a count). A refusal is a `warning` with `status: "refused"`, the reason and **rule names only**. A failed git or `gh` step is a `warning` with `status: "failed"` and the redacted reason (its own `skills.propose.failed` row in [event-vocabulary.md](event-vocabulary.md)). A dry run, an anonymous call, a 403 and a malformed body emit nothing; the audit chain records those that reach it. An event that cannot be stored never changes the answer.

Operator decisions emit `note` `skill.approve` / `skill.decline` / `skill.retire` and, for an attempt the rules refused, `warning` `skill.approve.refused` with a closed `rule` ([event-vocabulary.md](event-vocabulary.md)); see [Approving a skill](#approving-a-skill).

The route and the tool are audited as `skills_propose`, fail-closed ([mcp-audit.md](mcp-audit.md)).

## Configuration

| Variable | Default | |
|---|---|---|
| `SUBSTRATE_SKILLS_REPO` | `swcstudiospace/agent-skills` | The library's `owner/name` |
| `SUBSTRATE_SKILLS_REMOTE_URL` | `https://github.com/swcstudiospace/agent-skills.git` | What a clone's origin is set to and checked against |
| `SUBSTRATE_SKILLS_STATE` | `/var/lib/substrate/skills` | The proposer's state: `mirror.git`, `propose/` clones, `mirror.lock`, `locks/`, `proposals.jsonl` |
| `SUBSTRATE_SKILLS_GH` | `gh` | The `gh` binary |
| `SUBSTRATE_SKILLS_GOVERNANCE` | `off` | `off` \| `report` \| `enforce`: whether `skills_propose` records registry rows (`report`, `enforce`); see [Approving a skill](#approving-a-skill) |

A library other than the default is allowed only with a `file://` remote **and** an absolute `SUBSTRATE_SKILLS_GH`; otherwise the server boots with a warning naming the key and refuses to propose. That rule is what keeps the rehearsal harness off the real library.

`git` and `gh` run with an allowlisted environment: the four base keys `PATH`, `HOME` and the two no-prompt flags, plus seven controlled fixed Git values that isolate global/system gitconfig and select the `gh` credential helper (user-selected "Keep current Git isolation", 2026-10-11; fixed hardening values, never secrets): store URLs, surface tokens and the handoff key never reach a child. The mirror is bootstrapped by the operator once (`git clone --bare`, then `remote.origin.fetch +refs/heads/main:refs/heads/main`); a missing mirror is a 502 that prints the commands. The ledger (`proposals.jsonl`) keeps September's format so the host's existing ledger keeps deduplicating.

## Approving a skill

The owner's merge is still what publishes a skill. Since uplift-5 the substrate also keeps a **skills registry**, so that "which merged pull request was accepted, as which skill, by whom, at which merge commit" is a queryable fact instead of a host-local ledger line. It is the table `skills_registry` in the index (created idempotently by `IndexStore.migrate()`, never deleted from), one row per `(library repo, skill name, pull request number)`. A pull request is one content and one merge, so a name whose later merged content differs arrives through a different pull request and is a **new row** beside the first, never a silent replace.

**What `approved` means.** An operator recorded that this merged pull request (`merge_sha`), as this skill name, is acceptable. It does not install, link, unlink or delete anything. Today (`SUBSTRATE_SKILLS_GOVERNANCE=off`, the default) nothing reads it: the projector still links every skill that is on `main`.

| Surface | |
|---|---|
| MCP tool | `skills_approve`, `skills_list` over `/mcp` |
| REST | `POST /skills/approve` (JSON body), `GET /skills[?state=...]` |

`skills_approve` takes `{ name, pr_number, decision, reason? }`. It is **operator-only**: the caller's token must be a surface token that is also listed in `SUBSTRATE_OPERATOR_TOKENS` (a swarm surface and the `substrate` host-job surface are never operators). It runs in this order, and every refusal happens before the step after it:

1. authority: no surface is `401`, not an operator is `403`. On `POST /skills/approve` both are answered **before the body is read, parsed or audited**: an oversize or malformed body, or an audit outage, never turns a refusal into a `413`, `400` or `503`, and a refused caller leaves no audit record on the REST door (the MCP door audits the `tools/call` before dispatch). Nothing else has happened, nothing is emitted. For a caller that is an operator, `skills_approve` is fail-closed: `503` when the chain cannot take the record;
2. the values: `decision` is `approve`, `decline` or `retire`; `name` follows the skill-name rule; `pr_number` is a positive integer; `reason` is at most 500 characters and is redacted before it is stored. A refusal is `400` and one `skill.approve.refused` warning with a `rule` name;
3. the library configuration and the index (`503` when the index is not configured);
4. `gh pr view <n> --repo <library> --json state,mergeCommit,url,headRefName,baseRefName,files` for `approve` and `decline` (`retire` is a local state change and asks GitHub nothing). A failed `gh`, an unreadable answer or a missing or malformed field (`files` included: a list whose every entry has a string `path`; `baseRefName` included) is **`502` with no row and no event**. The pull request must be on the configured library (`pr_wrong_repo`, `409`) and must target the library's default branch, `main`, the base every proposal opens against (`pr_wrong_base`, `409`: a pull request merged into a stacked branch has a merge commit that never reached `main`). It must also be **bound to that skill** or it is refused with `pr_not_for_skill` (`400`). It is bound when EITHER (a) its head branch is one this substrate opened for that `name` (`skill/<surface>/<name>-<time>-<4 hex>`), OR (b) its changed files include exactly the path `<name>/SKILL.md`, the library layout (a skill is the directory `<name>/` at the library root holding `SKILL.md`, as `propose.ts` writes it and the projector's `libraryNames` reads it). (b) is what lets a skill merged through a hand-opened pull request be approved. The match is the whole path, never a prefix or a substring, so `demo` is not `demo-skill` and `demo-skill/references/SKILL.md` does not count; the name has already passed the skill-name rule, so nothing with `/` or `..` gets this far. `gh pr view` lists at most the first **100** changed files: a pull request with more whose `SKILL.md` falls past the cut is not bound by (b) and is refused (fail safe, never a guess); such a pull request needs the proposal-branch route or a smaller pull request. `approve` needs `MERGED` with a merge commit, `decline` needs `CLOSED` unmerged, an `OPEN` pull request is refused (`409`);
5. the row, in one transaction: **decisions are serialised per `(library, name)`** by a transaction-scoped Postgres advisory lock taken before the row is locked or the count is made, so two concurrent decisions on different pull requests of one name cannot both count the other's row as still approved: `remaining_approved_for_name` is the true post-decision total (of two concurrent retires of a name's last two approved rows, one answers `1` and the other `0`). Then `proposed` or no row moves to `approved` or `declined`; `approved` moves to `retired`; asking again for the state a row already has answers `exists` and changes nothing; every other move is `409` (`declined` and `retired` are final, a reopened and re-merged pull request does not revive them: propose again). A `retire` with no approved row for that pull request is `409`;
6. the decision's `note` (`skill.approve`, `skill.decline`, `skill.retire`: `name`, `pr_number`, `pr_url`, `merge_sha` for approve and retire, `decided_by`). The row is the decision and the event a best-effort trail: an event the ledger would not store never changes the answer or the row. The answer then carries `noted: false` (it is `noted: true` when stored, and absent for `exists`) and one stderr line names the row. Retrying does not help: it answers `exists` and emits nothing, so an unstored note is recorded by hand. The answer also carries `remaining_approved_for_name`, how many approved rows the name has after the decision.

`skills_list` answers `{ governance, library, skills, truncated }`, sorted by name (code-unit order), at most 500 entries (`truncated` says more exist), to any **authenticated** surface: a caller with no surface is `401`, also on a run that accepts untokened callers. `library` is the configured skills library's `owner/repo` slug (`SUBSTRATE_SKILLS_REPO`; never a URL or a credential), so a reader that caches the answer can bind the cache to the library as well as to the server it came from; the rows listed are that library's only. By default only **approved** names, **one entry per name** (its most recent approved row: latest `decided_at`, then highest pull request number), each `{ name, content_sha256, merge_sha, pr_url, approved_at, proposed_by }` (`GET /skills?state=approved` with the `substrate` token is the projector's read; it builds a set of names, so it needs no change). `state=proposed|declined|retired|all` is an operator action, lists every row (several per name) and adds `state`, `pr_number`, `decided_by`, `decided_at` and `reason`. **A name stays approved while any of its rows is approved**: a decision acts on one `(name, pull request)` row, so retiring the newer pull request leaves the name approved through the older one, and declining a later proposal never touches an earlier approval. To withdraw a name, retire every approved row; each decision's answer carries `remaining_approved_for_name`, which reaches `0` when the name is no longer listed. `governance` is the running mode: the registry is returned in every mode, so an empty list under `off` means nothing has been recorded, not that nothing is published. With no index configured or a failed read the answer is `503`, never an empty list, so an enforcing reader can tell "nothing approved" from "cannot read".

**`SUBSTRATE_SKILLS_GOVERNANCE`** is `off` (default), `report` or `enforce`; any other value is `off` with a boot warning.

| Mode | `skills_propose` | The two tools | Projector (U5-5b) |
|---|---|---|---|
| `off` | exactly as before: no registry write | work (approve is operator-only) | no effect |
| `report` | also records a `proposed` row once a pull request exists (`opened` or `existing`); a failed registry write never fails the proposal (warned once per streak, retried by the next proposal of the same content, and an approval creates a missing row itself) | work | warns about unapproved skills, links everything as today |
| `enforce` | as `report` | work | filters to the approved names |

This server half only stores and serves the registry; what a mode does to the projector is U5-5b's, and `enforce` is not safe until the registry holds every skill already on `main`.

**Bootstrap and grandfather risk.** Skills merged before the registry existed have no approved row. Nothing here bulk-approves them: a skill reaches `approved` only through an operator approving the pull request that brought it in, by number, one at a time. That works for the skills that arrived through a pull request (proposed by the substrate or opened by hand), not for a skill that was committed straight to `main`. Moving the projector to `enforce` before the registry holds every skill that must stay linked would stop linking the rest. The set of skills to grandfather, and how (approving their original pull requests, re-proposing, or an operator-run import), is an operator decision and is not built; run `report` and compare `skills_list` with `main` first.

**Limits.** The row's `content_sha256` is the proposal hash (over the redacted files), not a digest of the merged tree, so the registry does not prove the merged tree equals what was proposed; it records which merge commit was approved. A row for a pull request that was not proposed through the substrate has an empty `content_sha256` and no `proposed_by`. **The table is the source of truth; the `skill.*` events are a best-effort trail.** A decision whose note the ledger would not store still stands, and the answer says `noted: false` (one stderr line names the row): a re-run answers `exists` and emits nothing, so such a note is recorded by hand, not by retrying. `skills_registry` is not in the index archive (`docs/runbooks/index-archive.md`), so a lost table is rebuilt only by deciding the pull requests again (each of which emits a new note); the old notes are not a restore source. Pull requests bind to a skill by what GitHub lists (see step 4): the file list is at most 100 files, and a skill that exists on `main` without any pull request on the library (committed directly, or its pull request no longer retrievable) cannot be approved here; bringing those into the registry is an operator decision and is not built.

**Rollback** is `SUBSTRATE_SKILLS_GOVERNANCE=off`. The table is additive and stays; nothing is deleted and nothing is unlinked.

## The isolated proof

[rehearsal.md](rehearsal.md)'s `--skills-fixture` builds a throwaway library and a recording `gh` inside an instance's run directory, and `bun run smoke:skills-propose` drives all three doors against it with real `git`:

```sh
bun run rehearsal up --name p21 --skills-fixture
set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p21/consumer.env"; set +a
bun run smoke:skills-propose
bun run rehearsal down --name p21
```

Nothing in it can reach GitHub or `/var/lib/substrate/skills`. The first real PR on `agent-skills` is Phase 22's live proof.
