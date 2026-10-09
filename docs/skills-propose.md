# Proposing a skill

Tracked as SKILL-01 (v1.3 Phase 21). Owned by `packages/mcp-server/src/skills/propose.ts` (the git and `gh` path), `Substrate.proposeSkill` in `service.ts` (authority and events), and three doors that all end in that one method: the MCP tool `skills_propose`, `POST /skills/propose`, and `substrate skills propose`.

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
| 413 | The body is over 1 MB. Only on this route; other routes still answer an oversize body with a generic 500 |
| 502 | A `git` or `gh` step failed or a lock stayed busy. The message is redacted and at most 400 characters |
| 503 | The audit chain could not take the record. `skills_propose` is fail-closed, so nothing is proposed |

The MCP tool returns the same result as JSON, and an `isError` reply carrying the same `{ error, findings? }` for every failure the tool itself returns (a refusal, a failed `git`/`gh` step, a missing mirror, a busy lock, an unaudited chain). That promise covers only errors returned by the tool: when the MCP audit chain cannot take the record, the transport refuses the call before the tool runs and answers a JSON-RPC error (`code -32000`), not a tool body. The CLI prints `key=value` lines (`status`, `pr_url`, `pr_number`, `branch`, `content_sha256`, `redactions`, the diff counts, one `finding=<file>:<line> <rule>` per finding) and exits 0 for the five successes and 1 for a refusal, a failure, a 401, 403, 413 or 5xx, or a server that did not answer. Its request timeout is about 180 s (`SUBSTRATE_SKILLS_TIMEOUT_MS` overrides it): a proposal runs `git fetch`, `git push` and `gh` behind the request. A CLI flag that takes a value with none given (`--remove` with nothing after it) is refused before the directory is read or anything is posted.

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

The route and the tool are audited as `skills_propose`, fail-closed ([mcp-audit.md](mcp-audit.md)).

## Configuration

| Variable | Default | |
|---|---|---|
| `SUBSTRATE_SKILLS_REPO` | `swcstudiospace/agent-skills` | The library's `owner/name` |
| `SUBSTRATE_SKILLS_REMOTE_URL` | `https://github.com/swcstudiospace/agent-skills.git` | What a clone's origin is set to and checked against |
| `SUBSTRATE_SKILLS_STATE` | `/var/lib/substrate/skills` | The proposer's state: `mirror.git`, `propose/` clones, `mirror.lock`, `locks/`, `proposals.jsonl` |
| `SUBSTRATE_SKILLS_GH` | `gh` | The `gh` binary |

A library other than the default is allowed only with a `file://` remote **and** an absolute `SUBSTRATE_SKILLS_GH`; otherwise the server boots with a warning naming the key and refuses to propose. That rule is what keeps the rehearsal harness off the real library.

`git` and `gh` run with an allowlisted environment (`PATH`, `HOME` and the two no-prompt flags): store URLs, surface tokens and the handoff key never reach a child. The mirror is bootstrapped by the operator once (`git clone --bare`, then `remote.origin.fetch +refs/heads/main:refs/heads/main`); a missing mirror is a 502 that prints the commands. The ledger (`proposals.jsonl`) keeps September's format so the host's existing ledger keeps deduplicating.

## The isolated proof

[rehearsal.md](rehearsal.md)'s `--skills-fixture` builds a throwaway library and a recording `gh` inside an instance's run directory, and `bun run smoke:skills-propose` drives all three doors against it with real `git`:

```sh
bun run rehearsal up --name p21 --skills-fixture
set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p21/consumer.env"; set +a
bun run smoke:skills-propose
bun run rehearsal down --name p21
```

Nothing in it can reach GitHub or `/var/lib/substrate/skills`. The first real PR on `agent-skills` is Phase 22's live proof.
