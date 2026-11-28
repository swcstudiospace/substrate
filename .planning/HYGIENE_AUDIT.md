# Hygiene Audit — wave8 (`origin/main..HEAD`)

- Date: 2026-11-28
- Branch: `wave8/v19` @ `10b5ba8` (read-only audit; no history change, no code edits)
- Scope: full `git diff origin/main..HEAD` (92 files, +6792/−65) + targeted scans of `README.md`, `docs/`, `.env.example`, `infra/`, `.gitignore`, `LICENSE`
- Method: regex scans for token/key patterns (`sk-`, `ghp_`/`gho_`, `AKIA`, `BEGIN PRIVATE KEY`, `api-key/secret/password/token/bearer` assignments), high-entropy strings ≥40 chars, tailnet/host patterns (`tailscale`, `.ts.net`, `100.x`, `.lan`/`.local`/`.internal`), personal paths (`/home/`, `/Users/`, `/root/`, `/tmp/`), `--numstat`/`ls-tree` size review, binary-extension filter, `LICENSE`/`gitignore` verification

## Verdict

**Clean — no secrets, no tailnet names, no private keys, no large binaries introduced by this wave.** Three low-severity HITL-flagged observations below (all pre-existing or synthetic; none blocks).

## 1. Secrets / tokens / private keys — NONE FOUND

- Token/key regex over the full diff: **zero matches** (no `sk-`, `ghp_`/`gho_`, `xox*`, `AKIA`, `BEGIN PRIVATE KEY`, credential assignments, or `bearer` values).
- High-entropy (≥40-char) strings in added lines are all benign: git SHAs, phase slugs (`80-dg-1a-…` … `86-e5-…`), source paths (`packages/mcp-server/src/session-registry`, `…/shared-context`, …), and one UI menu-path sentence. No opaque secret-shaped values.
- `README.md`: no secret patterns (only architectural mention of Tailscale + links to `docs/data-planes.md`, `docs/railway-tailscale.md`).
- `docs/` + `infra/`: `tailscale`/`Tailscale` hits are architectural prose only (forwarder topology, `TS_AUTHKEY` *by name*, redaction-table entry for a `tskey-` key shape). **No `tskey-…` value, no `TS_AUTHKEY=…` value anywhere.**
- `.env.example` (1148 lines; wave adds only 4 comment lines plus an empty `SUBSTRATE_DRAGONFLY_GATE` entry, off by default): all sensitive keys are empty placeholders — GREPTIME_PASSWORD, SUBSTRATE_PG_URL and SUBSTRATE_OPERATOR_TOKENS are left blank. Targeted secret-value grep: **zero hits**.
- `.gitignore` correctly excludes `.env`/`.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.db`/`*.sqlite*`, `*.log`.

## 2. Internal hosts / tailnet names — NONE INTRODUCED

- No `.ts.net` machine names, no `100.x` Tailscale CGNAT IPs, no `tailnet` hostnames in the diff or in `infra/`/`.env.example`.
- `railway.internal` appears once (`docs/config-reference.md:234`) as the documented Railway-injected private-DNS pattern (`<service>.railway.internal`) — expected platform convention, not an internal leak.
- Only IP literals in `infra/` are `0.0.0.0`, `127.0.0.1`, and one public VPS bind (see HITL-1).

## 3. Personal paths — SYNTHETIC OR EPHEMERAL ONLY

- Diff adds 7× the literal worktree path `/tmp/agent-substrate-wave8` (plus one `cd /tmp/agent-substrate-wave8`) inside `.planning/phases/80–86` `CONTEXT.md`/`PLAN.md` files — ephemeral checkout path baked into planning prose (see HITL-2).
- Diff adds `/tmp/fake-worktree` + `home: "/home/someone"` in the new `packages/cli/src/session/operator.test.ts` rig — clearly synthetic test fixtures, consistent with pre-existing `/home/someone` fixtures in `checkpoint.test.ts`, `command.test.ts`, `hook.test.ts`, `transcript-ref.test.ts` (not in diff). No real user paths.
- No `/Users/`, `C:\Users`, `/root/`, or `/private/` paths in the diff.

## 4. Large binaries — NONE ADDED

- Binary-extension filter over added files (`*.png/jpg/gif/pdf/zip/tar/node/so/dylib/exe/bin/db/sqlite/mp4`): **zero hits**. New tracked files are `.planning/*.md`, `.gitkeep`, and `*.ts` sources/tests.
- Largest diff hunks are plain-text source/tests (top: `session-registry.ts` +434, `shared-context.test.ts` +368, `dragonfly-readiness.ts` +292).
- Largest HEAD blobs are pre-existing text sources, not wave additions: `service.ts` 511 KB / 10070 lines (502 KB already on `origin/main`; wave touches only +198/−1), `package-lock.json`, `service.test.ts`, `index-store.ts`, `bun.lock`. No action.

## 5. LICENSE — AGPL-3.0, UNTOUCHED

- `LICENSE` header confirms `GNU AFFERO GENERAL PUBLIC LICENSE Version 3`; `git diff origin/main..HEAD -- LICENSE` is empty. **Do not change** — no action taken.

## HITL-flagged items (all low; none blocks)

- **HITL-1 — Public VPS bind IP (pre-existing, not from this wave):** `infra/nginx/substrate.swcstudio.space.conf:25` has `listen 187.77.130.10:443 ssl http2;`. Last touched in #68; outside the wave diff. Confirm you are comfortable keeping a public VPS IP in-repo, or parameterize it (env/`map` include) in a follow-up.
- **HITL-2 — Ephemeral worktree path in planning docs (from this wave):** 7× `/tmp/agent-substrate-wave8` in `.planning/phases/80–86` CONTEXT/PLAN files. Harmless but machine-specific; confirm whether to leave as provenance or scrub to a relative placeholder in a docs-only pass.
- **HITL-3 — Informational:** `README.md:13-14` routes readers over Tailscale via `docs/data-planes.md` + `docs/railway-tailscale.md` with no hostnames/keys disclosed — no action; noted only because Tailscale-adjacent prose is what this audit was asked to watch.
