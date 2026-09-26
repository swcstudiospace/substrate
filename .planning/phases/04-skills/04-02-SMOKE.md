# 04-02 library migration evidence

Recorded from observed output only. 2026-09-26 (UTC, 04:06–04:35), after the owner answered
`approved` at the Task 2 checkpoint (04-02-SCAN.md). Every `gh` and network `git` call ran under
`env -i HOME=/root PATH=/usr/bin:/bin`, so the stored credential (`/root/.config/gh/hosts.yml`,
through the `gh auth git-credential` helper in `/root/.gitconfig`) answered. No token was passed,
read, printed or written, and every network command's output was piped through a token-shape mask.

## Commands

```
# rollback first (standing rule: route before the first live change)
S=/var/lib/substrate/phase4-baseline/04-02/20260926T040754Z
sudo install -d -m 0700 /var/lib/substrate/phase4-baseline/04-02 $S
sudo cp -a /root/agent-skills $S/agent-skills
find /root/agent-skills -mindepth 1 -maxdepth 1 -printf '%y\t%f\t%l\n' | sort > $S/agent-skills.listing.tsv
cd $S && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
# RESTORE.d/04-02.md written (checkout, mirror and repo routes); RESTORE.md index row added
sudo diff -rq -x __pycache__ -x '*.pyc' /root/agent-skills/ /var/lib/substrate/skills/vendor/   # exit 0: scanned tree = live content

# D-01
env -i HOME=/root PATH=/usr/bin:/bin gh repo view swcstudiospace/agent-skills --json name          # not found (exit 1)
env -i HOME=/root PATH=/usr/bin:/bin gh repo create swcstudiospace/agent-skills --private \
  --description "Shared agent skills library — Agent Substrate Phase 4"

# vendored commit + README commit + push (V=/var/lib/substrate/skills/vendor, the scanned tree)
git -C $V init -b main
git -C $V add -- README.md <the 40 names>
git -C $V commit -m "vendor: 40 skills from /root/agent-skills, symlinks dereferenced (D-02) Refs SPE-2734 Refs SPE-3576"
git -C $V add -- README.md
git -C $V commit -m "docs: README states the git-backed library and its projection Refs SPE-2734 Refs SPE-3576"
git -C $V remote add origin https://github.com/swcstudiospace/agent-skills.git
env -i HOME=/root PATH=/usr/bin:/bin git -C $V push -u origin main

# mirror
env -i HOME=/root PATH=/usr/bin:/bin git clone --bare https://github.com/swcstudiospace/agent-skills.git /var/lib/substrate/skills/mirror.git
git -C /var/lib/substrate/skills/mirror.git config remote.origin.fetch +refs/heads/main:refs/heads/main
env -i HOME=/root PATH=/usr/bin:/bin git -C /var/lib/substrate/skills/mirror.git fetch origin

# swap (Pitfall 1)
env -i HOME=/root PATH=/usr/bin:/bin git clone https://github.com/swcstudiospace/agent-skills.git /root/agent-skills.new
T0=$(date +%s%N); mv /root/agent-skills /root/agent-skills.phase4-old && mv /root/agent-skills.new /root/agent-skills; T1=$(date +%s%N)
rm -rf /root/agent-skills.phase4-old /var/lib/substrate/skills/vendor

# evidence
env -i HOME=/root PATH=/usr/bin:/bin gh repo view swcstudiospace/agent-skills --json visibility --jq .visibility
env -i HOME=/root PATH=/usr/bin:/bin gh repo view swcstudiospace/agent-skills --json defaultBranchRef --jq .defaultBranchRef.name
sudo grep -cE '^(GH_TOKEN|GITHUB_TOKEN)=' /etc/substrate/substrate.env
env -i HOME=/root PATH=/usr/bin:/bin git ls-remote https://github.com/swcstudiospace/agent-skills.git refs/heads/main
find <nine roots> -maxdepth 2 -xtype l 2>/dev/null | sort          # the 04-01 inventory command
grep -rhoE '/root/agent-skills/[A-Za-z0-9._/-]+' /root/.grok/skills/*/SKILL.md | sort -u   # then test -e each
df --output=avail -B1 / | tail -n 1
```

## Observed

- The repo was absent, then created: `https://github.com/swcstudiospace/agent-skills`. Commit 1 is
  `6e347906bca9a72eec954d4e8dba077882e8ea77`: 2,420 files (= `scan_files`), 41 top-level entries,
  modes 100644 ×2411 and 100755 ×9, no 120000 (symlink) or 160000 (submodule) entry, porcelain
  empty. Commit 2 is the README rewrite. The push created `main`, the empty repo's default branch.
- Before the swap, `/root/agent-skills.new` had 40 SKILL.md, 0 links, 0 .pyc, branch `main`, HEAD
  equal to the mirror's main, and a clean porcelain. `diff -rq -x .git -x README.md -x __pycache__
  -x '*.pyc'` against the live tree exited 0, and `cmp` showed the 25 per-skill `docs-*/README.md`
  files identical. The executable set is the same 9 scripts.
- `swap_rc=0`. The two renames ran back to back in one shell line.
- After the swap, the 04-01 inventory command finds no dangling link in the nine roots. That count
  includes the links into the library (04-BASELINE: Hermes 13, Omp 4, OpenClaw 10, OpenClaw
  workspace 10), which now resolve into the checkout. The link targets of the old tree (the
  docs-scraper exports and Hermes' `research/anda-ecosystem`) still exist.
- The mirror holds only `refs/heads/main`. Its fetch refspec is exactly
  `+refs/heads/main:refs/heads/main`. A `fetch origin` exited 0 and left main unchanged.
- The snapshot's `sha256sum -c --quiet MANIFEST.sha256` passed (28 entries) before the old tree was
  removed. `/var/lib/substrate/skills` is mode 700 and holds only `mirror.git`.

## Machine-readable

repo_visibility=PRIVATE
repo_default_branch=main
push_env=env-i
gh_token_in_env_file=0
library_head=3ac857273e02a9dfe2d35383a9ccbbc3f16ed7ec
mirror_head=3ac857273e02a9dfe2d35383a9ccbbc3f16ed7ec
checkout_branch=main
checkout_links=0
checkout_skill_md=40
checkout_pyc=0
checkout_clean=true
readme_commit=3ac857273e02a9dfe2d35383a9ccbbc3f16ed7ec
snapshot_dir=/var/lib/substrate/phase4-baseline/04-02/20260926T040754Z
swap_gap_ms=237
dangling_links_after=0
new_dangling_links=0
grok_script_paths=11
grok_script_paths_missing=0
disk_after=19593785344

vendor_commit=6e347906bca9a72eec954d4e8dba077882e8ea77
mirror_fetch_refspec=+refs/heads/main:refs/heads/main

## Gaps

- `swap_gap_ms=237` is measured between two `date` calls around two `mv` processes, on a host with
  load average 145–286 and about 220 MB of free memory at the time. The two `rename()` calls are
  not timed separately, so the real window is at most 237 ms.
- Git records only 644/755. Files that were 0600 in the old real directories are now 0644 in the
  checkout: 14 files, e.g. `anda-ecosystem/*` and several `*/SKILL.md`. Scripts that were 0711 are
  now 0755 (9 files). Content is identical (above). None of these files holds a credential (04-02-SCAN.md).
- `/root/.grok/skills/README.md` is a file, so the `*/SKILL.md` glob printed one "Not a directory"
  message on stderr. The 11 unique paths include `parallel-stock-deep-research` both with and
  without a trailing slash. All 11 exist before and after the swap.
- The README states the target design. The sync timer and the projector (04-04/04-05), the Hermes,
  Omp and OpenClaw settings and the rivet mounts (04-06) land in later plans. Until 04-04,
  nothing fast-forwards `/root/agent-skills`.
- One `gh repo view` hit a TLS handshake timeout under the host load. The same read-only query was
  re-run and answered (`PRIVATE`, `main`).
