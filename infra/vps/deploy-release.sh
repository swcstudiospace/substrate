#!/usr/bin/env bash
# Build an immutable release from a tagged commit on main and atomically swap
# /opt/agent-substrate/current. A failed health check points current back at
# the previous release and restarts the units. Only that previous release
# directory is kept after a health-checked deploy. SUBSTRATE_RELEASE_RESTART=0
# does not prune. --dry-run prints what a redeploy of the current tag, and what
# the next deploy of a NEW tag, would prune, with the bytes each would free; it
# deletes, creates and locks nothing.
#
# The script never prints an environment file and, apart from the opt-in gate
# below, never talks to a host other than the health URL (loopback by default).
# It reads /etc/substrate only to
# ask whether GREPTIME_URL and SUBSTRATE_PG_URL are set there — by name, with
# grep -q, never into a variable — so the store gate knows which stores the
# new process is expected to reach. It refuses to build below a free-disk
# floor (docs/runbooks/disk-pressure.md).
#
# Before the swap it runs two hooks from the NEW release tree. The preflight,
# scripts/deploy-preflight.ts (SUBSTRATE_DEPLOY_PREFLIGHT=off|report|enforce,
# default report), is read-only: it writes, starts and contacts nothing. The
# gate, scripts/release-gate.ts (SUBSTRATE_DEPLOY_GATE, default off), is NOT
# read-only: it boots scratch store containers through docker, pauses one of
# them, writes a run directory and needs disk and an image already present.
# For both, report prints and continues whatever happened; enforce refuses
# while current still points at the old release. The preflight is handed the
# env file's path and reads it itself, to run the new loadConfig against it; it
# prints names and verdicts only. This script still never reads it. The gate
# uses the rehearsal harness: scratch stores on loopback, never the production ports.
# Tests point SUBSTRATE_RELEASE_ROOT, PATH (git, bun, systemctl, curl, df),
# SUBSTRATE_HEALTH_ENV_FILE and SUBSTRATE_HEALTH_CMD at stubs. See
# infra/vps/README.md.
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_REPO=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)

ROOT=""
REPO=""
MAIN_REF="${SUBSTRATE_MAIN_REF:-main}"
RESTART="${SUBSTRATE_RELEASE_RESTART:-1}"
HEALTH_URL="${SUBSTRATE_HEALTH_URL:-http://127.0.0.1:7410/healthz}"
HEALTH_TIMEOUT="${SUBSTRATE_HEALTH_TIMEOUT:-5}"
HEALTH_DEADLINE="${SUBSTRATE_HEALTH_DEADLINE:-30}"
HEALTH_INTERVAL="${SUBSTRATE_HEALTH_INTERVAL:-1}"
UNIT_SETTLE="${SUBSTRATE_UNIT_SETTLE:-2}"
MIN_FREE_GB="${SUBSTRATE_DEPLOY_MIN_FREE_GB:-5}"
REQUIRE_STORES="${SUBSTRATE_HEALTH_REQUIRE_STORES:-1}"
HEALTH_ENV_FILE="${SUBSTRATE_HEALTH_ENV_FILE:-/etc/substrate/substrate.env}"
PREFLIGHT="${SUBSTRATE_DEPLOY_PREFLIGHT:-report}"
GATE="${SUBSTRATE_DEPLOY_GATE:-off}"
preflight_args=()
lockdir=""
tmp_link=""
health_config=""
health_body=""
units=()

die() {
	printf '%s\n' "deploy-release: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'EOF'
usage: deploy-release.sh <tag>
       deploy-release.sh rollback
       deploy-release.sh --dry-run

<tag> is a git tag whose commit is on main. The tree is archived into
$SUBSTRATE_RELEASE_ROOT/releases/<sha> (default /opt/agent-substrate),
dependencies are installed with bun install --frozen-lockfile, and
current is swapped atomically. rollback points current at previous.
--dry-run is read-only. It lists the release directories a health-checked
deploy would prune, in both cases: a redeploy of the current tag keeps current
and previous; the next deploy of a new tag keeps only the present current (it
becomes previous), so the present previous is listed as removable after it.
Bytes are unique bytes, counting hardlinks once.

Before the swap it also runs scripts/deploy-preflight.ts from the NEW release
(SUBSTRATE_DEPLOY_PREFLIGHT=off|report|enforce, default report) and, when
SUBSTRATE_DEPLOY_GATE is report or enforce (default off), scripts/release-gate.ts.
report prints and always continues; enforce refuses before current is changed.
--dry-run runs the preflight (report only) against the release that is current.
EOF
	exit 2
}

cleanup() {
	# Command substitutions inherit this trap. Only the main shell holds the lock.
	[[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
	if [[ -n "$tmp_link" ]]; then
		rm -f -- "$tmp_link"
	fi
	if [[ -n "$health_config" ]]; then
		rm -f -- "$health_config"
		health_config=""
	fi
	if [[ -n "$health_body" ]]; then
		rm -f -- "$health_body"
		health_body=""
	fi
	if [[ -n "$lockdir" ]]; then
		rmdir -- "$lockdir" 2>/dev/null || true
	fi
}
trap cleanup EXIT

validate_tag() {
	local tag="$1"
	[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "refusing tag name"
}

validate_rel() {
	local rel="$1"
	[[ "$rel" =~ ^releases/[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "refusing symlink target"
}

prepare_repo() {
	local requested="${SUBSTRATE_REPO:-$DEFAULT_REPO}"
	[[ -d "$requested" ]] || die "SUBSTRATE_REPO is not a directory"
	REPO=$(CDPATH='' cd -- "$requested" && pwd)
	[[ "$MAIN_REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]*$ ]] || die "refusing main ref"
}

prepare_root() {
	local requested="${SUBSTRATE_RELEASE_ROOT:-/opt/agent-substrate}"
	[[ "$requested" == /* ]] || die "SUBSTRATE_RELEASE_ROOT must be absolute"
	mkdir -p -- "$requested"
	ROOT=$(CDPATH='' cd -- "$requested" && pwd)
	[[ -n "$ROOT" && "$ROOT" != "/" && "$ROOT" != "$REPO" ]] || die "refusing release root"
	[[ "$RESTART" == "0" || "$RESTART" == "1" ]] || die "SUBSTRATE_RELEASE_RESTART must be 0 or 1"
	[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,2}$ ]] || die "SUBSTRATE_HEALTH_TIMEOUT must be 1-999 seconds"
	[[ "$HEALTH_DEADLINE" =~ ^[1-9][0-9]{0,3}$ ]] || die "SUBSTRATE_HEALTH_DEADLINE must be 1-9999 seconds"
	[[ "$HEALTH_INTERVAL" =~ ^[0-9]{1,2}$ ]] || die "SUBSTRATE_HEALTH_INTERVAL must be 0-99 seconds"
	[[ "$UNIT_SETTLE" =~ ^[0-9]{1,2}$ ]] || die "SUBSTRATE_UNIT_SETTLE must be 0-99 seconds"
	[[ "$MIN_FREE_GB" =~ ^[0-9]{1,4}$ ]] || die "SUBSTRATE_DEPLOY_MIN_FREE_GB must be 0-9999 gigabytes"
	[[ "$REQUIRE_STORES" == "0" || "$REQUIRE_STORES" == "1" ]] || die "SUBSTRATE_HEALTH_REQUIRE_STORES must be 0 or 1"
	[[ "$HEALTH_ENV_FILE" == /* ]] || die "SUBSTRATE_HEALTH_ENV_FILE must be absolute"
}

acquire_lock() {
	local candidate="$ROOT/.deploy.lock"
	mkdir -p -- "$ROOT/releases"
	if ! mkdir -- "$candidate" 2>/dev/null; then
		die "another deploy holds the lock"
	fi
	# Set only after mkdir wins, so a lost race does not rmdir the holder's lock.
	lockdir="$candidate"
}

# Refuse to build on a filesystem below the floor. A release tree and its
# node_modules land under $ROOT, and a host measured at 95 % disk is why this
# exists: a build that fills the disk takes the running units down with it.
# 0 disables the floor for an emergency deploy the operator has judged.
require_free_space() {
	local avail="" floor_kb avail_gb
	[[ "$MIN_FREE_GB" != "0" ]] || return 0
	{ read -r _ && read -r _ _ _ avail _; } < <(df -Pk -- "$ROOT") || die "cannot read free space on ${ROOT}"
	[[ "$avail" =~ ^[0-9]{1,15}$ ]] || die "cannot read free space on ${ROOT}"
	floor_kb=$((MIN_FREE_GB * 1024 * 1024))
	if ((avail < floor_kb)); then
		avail_gb=$((avail / 1024 / 1024))
		die "refusing to build: ${avail_gb} GB free on ${ROOT} is below SUBSTRATE_DEPLOY_MIN_FREE_GB=${MIN_FREE_GB}; see docs/runbooks/disk-pressure.md"
	fi
}

load_units() {
	local raw="${SUBSTRATE_RELEASE_UNITS:-substrate-mcp.service substrate-collector-grok.service substrate-collector-herdr.service substrate-collector-muse.service}"
	local unit
	units=()
	# Intentional word split: the operator passes a space-separated unit list.
	read -r -a units <<< "$raw"
	[[ ${#units[@]} -gt 0 ]] || die "no units configured"
	for unit in "${units[@]}"; do
		[[ "$unit" =~ ^[A-Za-z][A-Za-z0-9:@._-]*$ ]] || die "refusing unit name"
	done
}

resolve_tag() {
	local tag="$1" sha
	if ! git -C "$REPO" show-ref --verify --quiet "refs/tags/${tag}"; then
		die "refusing ${tag}: not a git tag"
	fi
	if ! sha=$(git -C "$REPO" rev-parse --verify "${tag}^{commit}"); then
		die "refusing ${tag}: tag does not resolve"
	fi
	sha="${sha,,}"
	[[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "refusing ${tag}: tag does not peel to a commit"
	if ! git -C "$REPO" merge-base --is-ancestor "$sha" "$MAIN_REF"; then
		die "refusing ${tag}: commit is not on ${MAIN_REF}"
	fi
	printf '%s\n' "$sha"
}

read_rel() {
	local link="$1" rel
	[[ -L "$link" ]] || return 1
	rel=$(readlink -- "$link") || return 1
	[[ "$rel" =~ ^releases/[0-9a-f]{40}([0-9a-f]{24})?$ ]] || return 1
	printf '%s\n' "$rel"
}

swap_link() {
	local link="$1" rel="$2"
	validate_rel "$rel"
	tmp_link="${link}.next.$$"
	ln -s "$rel" "$tmp_link"
	# mv -T replaces a symlink atomically. ln -sfn unlinks first.
	mv -Tf "$tmp_link" "$link"
	tmp_link=""
}

# ActiveState, SubState, and NRestarts. Empty or unexpected values fail closed.
unit_snapshot() {
	local unit="$1" line key value active="" sub="" restarts=""
	while IFS= read -r line; do
		[[ "$line" == *=* ]] || continue
		key="${line%%=*}"
		value="${line#*=}"
		case "$key" in
		ActiveState) active="$value" ;;
		SubState) sub="$value" ;;
		NRestarts) restarts="$value" ;;
		esac
	done < <(systemctl show -p ActiveState -p SubState -p NRestarts --no-pager -- "$unit")
	[[ "$active" =~ ^[A-Za-z-]{1,32}$ ]] || return 1
	[[ "$sub" =~ ^[A-Za-z-]{1,32}$ ]] || return 1
	[[ "$restarts" =~ ^[0-9]{1,6}$ ]] || return 1
	printf '%s %s %s\n' "$active" "$sub" "$restarts"
}

# The service type of a unit. Empty or unexpected values fail closed.
unit_type() {
	local unit="$1" line key value type=""
	while IFS= read -r line; do
		[[ "$line" == *=* ]] || continue
		key="${line%%=*}"
		value="${line#*=}"
		if [[ "$key" == "Type" ]]; then
			type="$value"
		fi
	done < <(systemctl show -p Type --no-pager -- "$unit")
	[[ "$type" =~ ^[A-Za-z-]{1,32}$ ]] || return 1
	printf '%s\n' "$type"
}

# The result of a unit's last run. Empty or unexpected values fail closed.
unit_result() {
	local unit="$1" line key value result=""
	while IFS= read -r line; do
		[[ "$line" == *=* ]] || continue
		key="${line%%=*}"
		value="${line#*=}"
		if [[ "$key" == "Result" ]]; then
			result="$value"
		fi
	done < <(systemctl show -p Result --no-pager -- "$unit")
	[[ "$result" =~ ^[A-Za-z-]{1,32}$ ]] || return 1
	printf '%s\n' "$result"
}

# A timer-driven Type=oneshot tick runs and exits, so it is never active:
# gating it on activeness would roll back every healthy deploy. Its real
# completed state is "not failed" with Result=success.
oneshot_settled() {
	local unit="$1" result
	if systemctl is-failed --quiet "$unit"; then
		printf '%s\n' "deploy-release: ${unit} is failed" >&2
		return 1
	fi
	result=$(unit_result "$unit") || return 1
	if [[ "$result" != "success" ]]; then
		printf '%s\n' "deploy-release: ${unit} has not completed (Result=${result})" >&2
		return 1
	fi
}

# Type=simple is active before Bun exits. Wait, then require the same NRestarts
# and a running substate so a collector crash loop cannot look healthy.
# Type=oneshot ticks are gated on completion instead (see oneshot_settled).
units_settled() {
	local unit snapshot active sub restarts baseline i type
	local -a watched=() bases=() oneshots=()
	[[ "$RESTART" == "1" ]] || return 0
	for unit in "${units[@]}"; do
		type=$(unit_type "$unit") || return 1
		if [[ "$type" == "oneshot" ]]; then
			oneshots+=("$unit")
			continue
		fi
		snapshot=$(unit_snapshot "$unit") || return 1
		read -r active sub restarts <<< "$snapshot"
		watched+=("$unit")
		bases+=("$restarts")
	done
	sleep "$UNIT_SETTLE"
	for i in "${!watched[@]}"; do
		unit="${watched[$i]}"
		baseline="${bases[$i]}"
		if ! systemctl is-active --quiet "$unit"; then
			printf '%s\n' "deploy-release: ${unit} is not active after ${UNIT_SETTLE}s" >&2
			return 1
		fi
		snapshot=$(unit_snapshot "$unit") || return 1
		read -r active sub restarts <<< "$snapshot"
		if [[ "$active" != "active" || "$sub" == "auto-restart" || "$restarts" != "$baseline" ]]; then
			printf '%s\n' "deploy-release: ${unit} is restart-looping after ${UNIT_SETTLE}s" >&2
			return 1
		fi
	done
	for unit in "${oneshots[@]}"; do
		oneshot_settled "$unit" || return 1
	done
}

restart_units() {
	local unit status=0
	[[ "$RESTART" == "1" ]] || return 0
	# Reload the unit files that are installed now, then restart. A reload that
	# happens only after this script returns would start the new code outside
	# the health check and outside rollback.
	systemctl daemon-reload || return 1
	# Called from `if`, where set -e does not stop the loop. Remember every failure.
	for unit in "${units[@]}"; do
		systemctl restart "$unit" || status=1
	done
	[[ "$status" -eq 0 ]] || return "$status"
	units_settled
}

# Last ExecStart in the unit file and its drop-ins wins, matching systemd.
unit_exec_start() {
	local unit="$1" file line key value section="" exec="" dropin
	local -a files=()
	files=("$SCRIPT_DIR/$unit")
	shopt -s nullglob
	for dropin in "$SCRIPT_DIR/${unit}.d"/*.conf; do
		files+=("$dropin")
	done
	shopt -u nullglob
	for file in "${files[@]}"; do
		[[ -f "$file" && ! -L "$file" ]] || continue
		section=""
		while IFS= read -r line || [[ -n "$line" ]]; do
			line="${line#"${line%%[![:space:]]*}"}"
			line="${line%"${line##*[![:space:]]}"}"
			[[ -z "$line" || "$line" == \#* ]] && continue
			if [[ "$line" =~ ^\[([^]]+)\]$ ]]; then
				section="${BASH_REMATCH[1]}"
				continue
			fi
			[[ "$section" == "Service" ]] || continue
			[[ "$line" == *=* ]] || continue
			key="${line%%=*}"
			value="${line#*=}"
			key="${key%"${key##*[![:space:]]}"}"
			if [[ "$key" == "ExecStart" ]]; then
				exec="$value"
			fi
		done < "$file"
	done
	printf '%s\n' "$exec"
}

# Repo-relative entry after the interpreter. -m is a module, not a file in the tree.
entry_from_exec() {
	local exec="$1" token
	local -a tokens=()
	local index=0
	read -r -a tokens <<< "$exec"
	[[ ${#tokens[@]} -gt 0 ]] || return 1
	index=1
	while [[ "$index" -lt ${#tokens[@]} ]]; do
		token="${tokens[$index]}"
		if [[ "$token" == "-m" ]]; then
			return 1
		fi
		if [[ "$token" == -* ]]; then
			index=$((index + 1))
			continue
		fi
		[[ "$token" == /* || "$token" == *".."* ]] && return 1
		printf '%s\n' "$token"
		return 0
	done
	return 1
}

require_release_entries() {
	local dest="$1" unit exec entry
	for unit in "${units[@]}"; do
		exec=$(unit_exec_start "$unit")
		[[ -n "$exec" ]] || die "unit ${unit} has no ExecStart"
		if ! entry=$(entry_from_exec "$exec"); then
			die "unit ${unit} has no release entry"
		fi
		[[ "$entry" =~ ^[A-Za-z0-9._/-]+$ ]] || die "refusing entry path"
		if [[ ! -f "$dest/$entry" || -L "$dest/$entry" ]]; then
			die "release is missing ${entry}"
		fi
	done
}

# Write a mode-0600 curl config. The token stays out of argv and out of the log.
write_health_config() {
	local file="${SUBSTRATE_HEALTH_TOKEN_FILE:-}" token
	[[ -n "$file" ]] || return 0
	[[ -n "$health_config" ]] && return 0
	[[ "$file" == /* && -f "$file" && ! -L "$file" ]] || die "SUBSTRATE_HEALTH_TOKEN_FILE must be an absolute regular file"
	token=$(<"$file") || die "refusing health token file"
	token="${token//$'\r'/}"
	token="${token%$'\n'}"
	[[ "$token" != *$'\n'* && "$token" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]] || die "refusing health token file"
	health_config=$(mktemp "${TMPDIR:-/tmp}/substrate-health.XXXXXX")
	chmod 600 "$health_config"
	printf 'header = "Authorization: Bearer %s"\n' "$token" > "$health_config"
}

prepare_health() {
	[[ "$RESTART" == "1" ]] || return 0
	if [[ -n "${SUBSTRATE_HEALTH_CMD:-}" ]]; then
		if [[ "${SUBSTRATE_HEALTH_CMD}" != /* || ! -x "${SUBSTRATE_HEALTH_CMD}" || -L "${SUBSTRATE_HEALTH_CMD}" ]]; then
			die "SUBSTRATE_HEALTH_CMD must be an absolute executable path"
		fi
		return 0
	fi
	if [[ "$HEALTH_URL" == *"@"* || ! "$HEALTH_URL" =~ ^https?://[^[:space:]]+$ ]]; then
		die "refusing health url"
	fi
	write_health_config
	# The body of the answer that passes the poll, kept for the store gate so
	# the gate judges the same response the status code came from.
	health_body=$(mktemp "${TMPDIR:-/tmp}/substrate-healthz.XXXXXX")
	chmod 600 "$health_body"
}

# 0 healthy, 7 still starting (retry), 22 definitive HTTP failure.
health_once() {
	local code
	local -a args=()
	if [[ -n "${SUBSTRATE_HEALTH_CMD:-}" ]]; then
		"${SUBSTRATE_HEALTH_CMD}"
		return $?
	fi
	args=(-sS --max-time "$HEALTH_TIMEOUT" -o "${health_body:-/dev/null}" -w '%{http_code}')
	if [[ -n "$health_config" ]]; then
		args+=(-K "$health_config")
	fi
	code=$(curl "${args[@]}" -- "$HEALTH_URL" || true)
	case "$code" in
	2[0-9][0-9]) return 0 ;;
	000 | "") return 7 ;;
	401)
		printf '%s\n' "deploy-release: healthz returned 401; set SUBSTRATE_HEALTH_TOKEN_FILE or SUBSTRATE_HEALTH_CMD" >&2
		return 22
		;;
	*)
		printf '%s\n' "deploy-release: healthz returned ${code}" >&2
		return 22
		;;
	esac
}

health_ok() {
	local start now status
	[[ "$RESTART" == "1" ]] || return 0
	start=$(date +%s)
	while true; do
		# `if cmd` clears $? when cmd fails, so the status has to be captured here.
		status=0
		health_once || status=$?
		if [[ "$status" -eq 0 ]]; then
			return 0
		fi
		# A custom command and any HTTP answer are the verdict. Connection
		# refused is the Type=simple gap before the port is open.
		if [[ "$status" -eq 22 || -n "${SUBSTRATE_HEALTH_CMD:-}" ]]; then
			return 1
		fi
		now=$(date +%s)
		if (( now - start >= HEALTH_DEADLINE )); then
			printf '%s\n' "deploy-release: health check failed after ${HEALTH_DEADLINE}s" >&2
			return 1
		fi
		sleep "$HEALTH_INTERVAL"
	done
}

# Whether an env file sets NAME to a non-empty value. Presence only: the value
# is never read into a variable and never printed. An unreadable or missing
# file configures nothing.
env_sets() {
	local file="$1" name="$2"
	[[ -f "$file" && ! -L "$file" ]] || return 1
	grep -q -- "^${name}=." "$file" 2>/dev/null
}

# true, false, or empty when the body has no top-level boolean of that name.
# The body is this server's own /healthz. A nested object under the same name
# (planes carries an "index" entry) does not match: a boolean must follow the key.
health_bool() {
	local body="$1" key="$2"
	if [[ "$body" =~ \"$key\"[[:space:]]*:[[:space:]]*(true|false) ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
	fi
}

# The plane whose breaker is open, or nothing. A breaker snapshot writes `plane`
# before `state` and nests no object, so one brace pair holds both; a breaker
# that is null (breakers disabled) has no brace pair and never matches.
open_breaker() {
	local body="$1"
	[[ "$body" == *'"planes"'* ]] || return 0
	if [[ "$body" =~ \"breaker\"[[:space:]]*:[[:space:]]*\{[^{}]*\"plane\"[[:space:]]*:[[:space:]]*\"([a-z]+)\"[^{}]*\"state\"[[:space:]]*:[[:space:]]*\"open\" ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
	fi
}

# The stores behind the status code. /healthz answers 200 while the index is
# down (the brief still composes from the ledger) and, with no ledger
# configured, while nothing is writable — so a deploy that looked only at the
# code published a release nobody could record a claim on. Each store is
# required only when the env file names it, and an open breaker (`planes`)
# means the new process is already refusing that plane. A custom
# SUBSTRATE_HEALTH_CMD is the operator's whole verdict and is not second-guessed.
stores_ok() {
	local body index events plane
	[[ "$RESTART" == "1" && "$REQUIRE_STORES" == "1" ]] || return 0
	[[ -z "${SUBSTRATE_HEALTH_CMD:-}" ]] || return 0
	if [[ -z "$health_body" || ! -s "$health_body" ]]; then
		printf '%s\n' "deploy-release: healthz answered with no body, so the stores cannot be checked" >&2
		return 1
	fi
	body=$(<"$health_body")
	if env_sets "$HEALTH_ENV_FILE" SUBSTRATE_PG_URL; then
		index=$(health_bool "$body" index)
		if [[ "$index" != "true" ]]; then
			printf '%s\n' "deploy-release: healthz reports index=${index:-missing} while SUBSTRATE_PG_URL is configured" >&2
			return 1
		fi
	fi
	if env_sets "$HEALTH_ENV_FILE" GREPTIME_URL; then
		events=$(health_bool "$body" eventsWritable)
		if [[ "$events" != "true" ]]; then
			printf '%s\n' "deploy-release: healthz reports eventsWritable=${events:-missing} while GREPTIME_URL is configured" >&2
			return 1
		fi
	fi
	plane=$(open_breaker "$body")
	if [[ -n "$plane" ]]; then
		printf '%s\n' "deploy-release: healthz reports the ${plane} plane's breaker open" >&2
		return 1
	fi
}

build_release() {
	local sha="$1"
	local dest="$ROOT/releases/$sha"
	[[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "refusing release name"
	if [[ -L "$dest" ]]; then
		die "refusing to replace a symlinked release path"
	fi
	if [[ -f "$dest/.release-ready" && "$(<"$dest/.release-ready")" == "$sha" && -d "$dest/node_modules" && -f "$dest/package.json" && -f "$dest/bun.lock" ]]; then
		return 0
	fi
	rm -rf -- "$dest"
	mkdir -p -- "$dest"
	if ! git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$dest"; then
		rm -rf -- "$dest"
		die "git archive failed"
	fi
	if [[ ! -f "$dest/package.json" || ! -f "$dest/bun.lock" ]]; then
		rm -rf -- "$dest"
		die "archive is missing package.json or bun.lock"
	fi
	if ! (cd -- "$dest" && bun install --frozen-lockfile); then
		rm -rf -- "$dest"
		die "bun install failed"
	fi
	printf '%s\n' "$sha" > "$dest/.release-ready"
}

prune_releases() {
	local keep_current="$1" keep_previous="${2:-}" path base
	local -a paths=()
	shopt -s nullglob
	paths=("$ROOT/releases"/*)
	shopt -u nullglob
	for path in "${paths[@]}"; do
		base=$(basename -- "$path")
		[[ "$base" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die "refusing to prune unexpected release name"
		if [[ "$base" == "$keep_current" || ( -n "$keep_previous" && "$base" == "$keep_previous" ) ]]; then
			continue
		fi
		[[ -L "$path" ]] && die "refusing to prune a symlink"
		rm -rf -- "$path"
	done
}

sha_of() {
	printf '%s\n' "${1#releases/}"
}

# What the prune would remove, and the bytes that would free. Read-only: no
# mkdir, no lock, no rm. Two cases, because a deploy keeps a different set
# depending on the tag:
#   redeploy of the current tag: keeps current and previous.
#   deploy of a NEW tag: the new release becomes current and the present current
#     becomes previous, so the present previous is pruned with the rest.
# Both are printed. Bytes come from ONE `du` over current, previous, then the
# rest newest first. Release trees share hardlinked node_modules, and a `du` per
# tree charges every tree the whole thing (a 38 MB release showed next to a
# "2.9 GB" one that way); one du counts an inode the first time it meets it, so
# a release is charged only what the ones before it do not already hold. The
# new release's own shared bytes are not known here and are not subtracted.
cmd_dry_run() {
	local requested="${SUBSTRATE_RELEASE_ROOT:-/opt/agent-substrate}" root cur="" prev="" name path role bytes du_out
	local total=0 would_free=0 refused=0 removable=0 prev_bytes=0 has_prev=0
	local -a names=() ordered=()
	[[ "$requested" == /* ]] || die "SUBSTRATE_RELEASE_ROOT must be absolute"
	[[ -d "$requested/releases" ]] || die "no releases directory under ${requested}"
	root=$(CDPATH='' cd -- "$requested" && pwd)
	if [[ -L "$root/current" ]]; then
		cur=$(read_rel "$root/current") || die "refusing current symlink"
		cur=$(sha_of "$cur")
	fi
	if [[ -L "$root/previous" ]]; then
		prev=$(read_rel "$root/previous") || die "refusing previous symlink"
		prev=$(sha_of "$prev")
		[[ "$prev" != "$cur" ]] || prev=""
	fi
	# `ls -t` is newest first. Names are checked before use, exactly as prune does.
	while IFS= read -r name; do
		[[ -n "$name" ]] || continue
		if [[ ! "$name" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ || -L "$root/releases/$name" || ! -d "$root/releases/$name" ]]; then
			printf '%s\n' "refuse: releases/${name//[^[:print:]]/?} is not a plain release directory; the real prune would abort on it"
			refused=1
			continue
		fi
		names+=("$name")
	done < <(ls -1t -- "$root/releases")
	for name in "$cur" "$prev"; do
		[[ -n "$name" && -d "$root/releases/$name" ]] || continue
		[[ " ${ordered[*]:-} " == *" $name "* ]] && continue
		ordered+=("$name")
	done
	for name in "${names[@]:-}"; do
		[[ -n "$name" ]] || continue
		[[ " ${ordered[*]:-} " == *" $name "* ]] && continue
		ordered+=("$name")
	done
	if [[ ${#ordered[@]} -eq 0 ]]; then
		printf '%s\n' "dry-run: no release directories under ${root}/releases; nothing would be removed"
		dry_run_preflight
		return "$refused"
	fi
	local -a paths=()
	for name in "${ordered[@]}"; do
		paths+=("$root/releases/$name")
	done
	du_out=$(du -s --block-size=1 -- "${paths[@]}") || die "du failed on the release directories"
	while IFS=$'\t' read -r bytes path; do
		[[ "$bytes" =~ ^[0-9]{1,15}$ && -n "$path" ]] || continue
		name="${path##*/}"
		total=$((total + bytes))
		role=""
		if [[ "$name" == "$cur" ]]; then
			role="current"
		elif [[ "$name" == "$prev" ]]; then
			role="previous"
		fi
		if [[ "$role" == "current" ]]; then
			printf 'keep current %s %s bytes (%s MiB unique)\n' "$name" "$bytes" "$((bytes / 1048576))"
		elif [[ "$role" == "previous" ]]; then
			printf 'keep previous %s %s bytes (%s MiB unique): kept by a redeploy of the current tag, would remove after the next new-tag deploy\n' "$name" "$bytes" "$((bytes / 1048576))"
			prev_bytes="$bytes"
			has_prev=1
		else
			printf 'would-remove %s %s bytes (%s MiB unique)\n' "$name" "$bytes" "$((bytes / 1048576))"
			would_free=$((would_free + bytes))
			removable=$((removable + 1))
		fi
	done <<< "$du_out"
	printf 'dry-run: a redeploy of the current tag would remove %s release(s), freeing %s bytes (%s MiB) of %s bytes counted once\n' \
		"$removable" "$would_free" "$((would_free / 1048576))" "$total"
	printf 'dry-run: the next deploy of a new tag would remove %s release(s), freeing %s bytes (%s MiB): the same set plus the present previous (%s bytes)\n' \
		"$((removable + has_prev))" "$((would_free + prev_bytes))" "$(((would_free + prev_bytes) / 1048576))" "$prev_bytes"
	printf '%s\n' "dry-run: nothing was deleted"
	if [[ -z "$cur" ]]; then
		printf '%s\n' "dry-run: current is not set, so every release is listed as removable; a deploy would keep the new release and its predecessor"
	fi
	# After the prune report, so what it printed stays first; the preflight only prints and returns 0,
	# so the exit code stays the prune report's.
	dry_run_preflight
	return "$refused"
}

# SUBSTRATE_DEPLOY_PREFLIGHT and SUBSTRATE_DEPLOY_GATE take exactly these three
# values. A typo is refused before anything is built: an `enforce` that quietly
# became `report` would let through the very deploy it was set to stop.
validate_hook_modes() {
	[[ "$PREFLIGHT" == "off" || "$PREFLIGHT" == "report" || "$PREFLIGHT" == "enforce" ]] || die "SUBSTRATE_DEPLOY_PREFLIGHT must be off, report or enforce"
	[[ "$GATE" == "off" || "$GATE" == "report" || "$GATE" == "enforce" ]] || die "SUBSTRATE_DEPLOY_GATE must be off, report or enforce"
}

# Run one bun script from inside a release tree. Returns the script's exit code,
# or 2 when it cannot run at all (no bun on PATH, or the release does not ship
# the script) — callers treat 2 as "unavailable", never as a pass. Never exits
# the shell, so `report` mode can always continue.
run_release_script() {
	local dest="$1" script="$2" status=0
	shift 2
	if ! command -v bun > /dev/null 2>&1; then
		printf '%s\n' "deploy-release: bun is not on PATH, so ${script} did not run" >&2
		return 2
	fi
	if [[ ! -f "$dest/$script" || -L "$dest/$script" ]]; then
		printf '%s\n' "deploy-release: the release has no ${script}" >&2
		return 2
	fi
	(cd -- "$dest" && SUBSTRATE_DEPLOY_MIN_FREE_GB="$MIN_FREE_GB" bun "$script" "$@") || status=$?
	return "$status"
}

# The preflight's arguments for a release tree. It reads the unit's env file
# itself and prints names and verdicts only; this script never loads the file.
# The two overrides exist so tests (and a host with a non-default layout) can
# point it elsewhere; unset, the preflight's own defaults apply.
build_preflight_args() {
	preflight_args=("$1" --env-file "$HEALTH_ENV_FILE")
	[[ -z "${SUBSTRATE_PREFLIGHT_STATE_DIR:-}" ]] || preflight_args+=(--state-dir "$SUBSTRATE_PREFLIGHT_STATE_DIR")
	[[ -z "${SUBSTRATE_PREFLIGHT_INSTALLED_UNITS_DIR:-}" ]] || preflight_args+=(--installed-units-dir "$SUBSTRATE_PREFLIGHT_INSTALLED_UNITS_DIR")
}

# Before the swap: would the NEW release's config loader, state files and unit
# settings start against this host (scripts/deploy-preflight.ts, read-only).
# `report` prints the table and ALWAYS continues, whatever happened to the
# preflight. `enforce` refuses while `current` still points at the old
# release, so nothing needs rolling back. The table goes to stderr: stdout
# stays the one `current -> ...` line a caller may parse.
run_preflight() {
	local dest="$1" status=0
	[[ "$PREFLIGHT" != "off" ]] || return 0
	build_preflight_args "$dest"
	run_release_script "$dest" scripts/deploy-preflight.ts "${preflight_args[@]}" >&2 || status=$?
	if [[ "$status" -eq 0 ]]; then
		printf '%s\n' "deploy-release: preflight passed (mode ${PREFLIGHT})" >&2
		return 0
	fi
	if [[ "$PREFLIGHT" == "enforce" ]]; then
		die "refusing to swap current: the preflight did not pass (exit ${status}) under SUBSTRATE_DEPLOY_PREFLIGHT=enforce; current was not changed"
	fi
	printf '%s\n' "deploy-release: preflight did not pass (exit ${status}); SUBSTRATE_DEPLOY_PREFLIGHT=report continues" >&2
}

# Before the swap: the boot-and-prove gate from the NEW tree
# (scripts/release-gate.ts). Its exit codes: 0 pass, 1 a check failed, 2
# unavailable (docker, image or disk). `report` prints the receipt and
# continues. `enforce` refuses on anything but 0, an unavailable gate
# included: a gate that could not run proved nothing.
run_gate() {
	local dest="$1" status=0 result
	[[ "$GATE" != "off" ]] || return 0
	run_release_script "$dest" scripts/release-gate.ts >&2 || status=$?
	case "$status" in
	0) result="pass" ;;
	1) result="fail" ;;
	*) result="unavailable" ;;
	esac
	printf '%s\n' "deploy-release: gate-receipt mode=${GATE} result=${result} exit=${status} release=${dest##*/}" >&2
	if [[ "$status" -ne 0 && "$GATE" == "enforce" ]]; then
		die "refusing to swap current: the release gate is ${result} (exit ${status}) under SUBSTRATE_DEPLOY_GATE=enforce; current was not changed"
	fi
}

# --dry-run: the preflight of the release that is current now, report only
# (the dry-run has no tag to build). Prints and changes nothing, and always
# returns 0 so it can never alter the prune report's exit code.
dry_run_preflight() {
	local requested="${SUBSTRATE_RELEASE_ROOT:-/opt/agent-substrate}" root cur="" status=0
	[[ "$PREFLIGHT" != "off" ]] || return 0
	if [[ "$PREFLIGHT" != "report" && "$PREFLIGHT" != "enforce" ]]; then
		printf '%s\n' "dry-run: SUBSTRATE_DEPLOY_PREFLIGHT=${PREFLIGHT//[^[:print:]]/?} is not off, report or enforce; a deploy would refuse it, and no preflight ran"
		return 0
	fi
	root=$(CDPATH='' cd -- "$requested" && pwd) || return 0
	if [[ -L "$root/current" ]]; then
		cur=$(read_rel "$root/current") || cur=""
	fi
	if [[ -z "$cur" || ! -d "$root/$cur" ]]; then
		printf '%s\n' "dry-run: preflight skipped: there is no current release to run it against"
		return 0
	fi
	printf '%s\n' "dry-run: preflight of the current release ${cur#releases/}, report only (a deploy runs it against the new release)"
	build_preflight_args "$root/$cur"
	run_release_script "$root/$cur" scripts/deploy-preflight.ts "${preflight_args[@]}" || status=$?
	printf '%s\n' "dry-run: preflight exit ${status}; nothing was changed"
	return 0
}

restore_current() {
	local old="$1"
	if [[ -n "$old" ]]; then
		swap_link "$ROOT/current" "$old"
		restart_units || printf '%s\n' "deploy-release: restart after rollback failed" >&2
	else
		rm -f -- "$ROOT/current"
	fi
}

cmd_deploy() {
	local tag="$1" sha old="" keep_prev="" prev_rel=""
	validate_hook_modes
	if ! sha=$(resolve_tag "$tag"); then
		exit 1
	fi
	load_units
	require_free_space
	build_release "$sha"
	require_release_entries "$ROOT/releases/$sha"
	run_preflight "$ROOT/releases/$sha"
	run_gate "$ROOT/releases/$sha"
	prepare_health
	if [[ -L "$ROOT/current" ]]; then
		if ! old=$(read_rel "$ROOT/current"); then
			die "refusing current symlink"
		fi
	fi
	swap_link "$ROOT/current" "releases/$sha"
	if ! restart_units || ! health_ok || ! stores_ok; then
		printf '%s\n' "deploy-release: health check failed; rolling back" >&2
		restore_current "$old"
		exit 1
	fi
	if [[ -n "$old" && "$old" != "releases/$sha" ]]; then
		swap_link "$ROOT/previous" "$old"
		keep_prev=$(sha_of "$old")
	elif [[ -L "$ROOT/previous" ]]; then
		if ! prev_rel=$(read_rel "$ROOT/previous"); then
			die "refusing previous symlink"
		fi
		keep_prev=$(sha_of "$prev_rel")
	fi
	# A no-restart publish must not delete a tree a process may still be running from.
	if [[ "$RESTART" == "1" ]]; then
		prune_releases "$sha" "$keep_prev"
	fi
	printf '%s\n' "current -> releases/$sha"
}

cmd_rollback() {
	local prev="" cur=""
	load_units
	prepare_health
	if ! prev=$(read_rel "$ROOT/previous"); then
		die "no previous release to roll back to"
	fi
	if [[ -L "$ROOT/current" ]]; then
		if ! cur=$(read_rel "$ROOT/current"); then
			die "refusing current symlink"
		fi
	fi
	swap_link "$ROOT/current" "$prev"
	if ! restart_units || ! health_ok; then
		printf '%s\n' "deploy-release: rollback health check failed; restoring current" >&2
		restore_current "$cur"
		exit 1
	fi
	if [[ -n "$cur" && "$cur" != "$prev" ]]; then
		swap_link "$ROOT/previous" "$cur"
	fi
	printf '%s\n' "current -> $prev"
}

main() {
	local cmd="${1:-}"
	case "$cmd" in
	-h | --help | help) usage ;;
	rollback)
		[[ $# -eq 1 ]] || usage
		prepare_repo
		prepare_root
		acquire_lock
		cmd_rollback
		;;
	--dry-run)
		[[ $# -eq 1 ]] || usage
		cmd_dry_run
		;;
	"")
		usage
		;;
	*)
		[[ $# -eq 1 ]] || usage
		validate_tag "$cmd"
		prepare_repo
		prepare_root
		acquire_lock
		cmd_deploy "$cmd"
		;;
	esac
}

main "$@"
