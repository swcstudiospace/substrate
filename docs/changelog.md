# Changelog

Shipped changes, newest first. Each entry names the switch or command an operator uses. Commit hashes give the detail.

## 2026-11-14

### Claim refused while a prerequisite is open (SPE-5717)

- `graph_claim` is refused with reason `prerequisite-open` while a `requires` or `gated_by` prerequisite of the node is open. A prerequisite is open until its node is `completed`. The reply names it in `prerequisite`.
- A refused claim grants no lease and writes nothing: no index write, no event, no mirror. A holder's renewal is refused the same way while a prerequisite is open.
- `blocks` edges do not hold a claim.

### Cycles refused before the index write

- Cycles through any edge kind are refused before the index write.

### Operator all-markdown docs ingest: `substrate docs ingest-all` (707bc903, d2f573fe)

- Operator-run only. The CLI is the only entry. The server boot path never imports the job, and no timer runs it.
- Dry run is the default. It writes `report.json`, `summary.md` and `leave-out.json` to `--state-dir` and sends nothing. `--apply` is required to send pages. `--dry-run` and `--apply` exclude each other.
- With `--apply`, pages go to one LightRAG dataset per repo, from the dataset registry. Every page passes the ingest's own secret gate before it is sent.
- Refused pages are never sent. `leave-out.json` records each one by path, rule names and content hash only.
- Selection excludes milestone archives and symlinks, counts over-cap pages without reading them, and dedups raw copies within a group.
- Dot-named directories are skipped during group discovery and counted as `dot_dirs_skipped`. The walk still reads `.planning/` and `.github/`.
- Planning pages carry their checkout, so pages from a worktree pass the ingest guard.

### Planning pass switch: `SUBSTRATE_PLANNING_PASS` (4091a442)

- `on` is the default, and unset means `on`. Behaviour is unchanged.
- `off` suppresses the planning pass at boot, on the poll timer, and on planning events and requests. Nothing under `.planning/` is read or written for LightRAG.
- The checkouts and the dataset registry still derive from `SUBSTRATE_PLANNING_ROOTS`, so search and merge-trigger keep working. With the pass off, the all-markdown job is the only LightRAG writer.
- Accepted values are `on` and `off`, case- and space-insensitive. Any other value, blank included, refuses the planning settings with a typed error that names the variable. The value is never echoed.

### Secret gate narrowing: REDACTION and skill rules (699b8f7a, ca444014)

- The six REDACTION rules (assignment, authorization, password, password-env, api-key-lower, bearer) get shared placeholder guards, `_FILE`/`_PATH` key exemptions, env-reference guards and a fixed bearer word list. Separators that can cross a newline stay multi-line on this path, so a secret on the next line is still refused. A read-only classifier over dry-run hits removed no real-looking hit.
- Skill rules get the same narrowing: placeholder guards, `_FILE`/`_PATH` exemptions, env-reference guards, a backtick-identifier guard on uppercase assignment keys, and the fixed bearer word list. Separators stay line-local on the skill path.
- Fail-closed corrections:
  - Backticks are not placeholders on either path, so a backticked real value stays refused.
  - The authorization rule has no backtick exemption.
  - Placeholder run forms (`xxx`, `***`, `...`, `[REDACTED`) need a non-alphanumeric boundary. A real value that merely begins with one stays refused.
