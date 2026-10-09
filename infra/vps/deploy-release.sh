#!/usr/bin/env bash
# Build an immutable release from a tagged commit on main and atomically swap
# /opt/agent-substrate/current. A failed health check points current back at
# the previous release and restarts the units. Only that previous release
# directory is kept after a health-checked deploy. SUBSTRATE_RELEASE_RESTART=0
# does not prune.
#
# The script never reads /etc/substrate, never prints an environment file,
# and never talks to a host other than the health URL (loopback by default).
# Tests point SUBSTRATE_RELEASE_ROOT, PATH (git, bun, systemctl, curl) and
# SUBSTRATE_HEALTH_CMD at stubs. See infra/vps/README.md.
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
lockdir=""
tmp_link=""
health_config=""
units=()

die() {
	printf '%s\n' "deploy-release: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'EOF'
usage: deploy-release.sh <tag>
       deploy-release.sh rollback

<tag> is a git tag whose commit is on main. The tree is archived into
$SUBSTRATE_RELEASE_ROOT/releases/<sha> (default /opt/agent-substrate),
dependencies are installed with bun install --frozen-lockfile, and
current is swapped atomically. rollback points current at previous.
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

	# Timers (substrate-docs-refresh.timer) are not restart units: they have no
	# ExecStart entry to check, and a deploy's daemon-reload already picks up
	# their file changes. Enabling a timer on the host is a live step.
load_units() {
	local raw="${SUBSTRATE_RELEASE_UNITS:-substrate-mcp.service substrate-collector-grok.service substrate-collector-herdr.service substrate-collector-muse.service substrate-docs-refresh.service}"
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

# Type=simple is active before Bun exits. Wait, then require the same NRestarts
# and a running substate so a collector crash loop cannot look healthy.
units_settled() {
	local unit snapshot active sub restarts baseline i
	local -a watched=() bases=()
	[[ "$RESTART" == "1" ]] || return 0
	for unit in "${units[@]}"; do
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
}

# 0 healthy, 7 still starting (retry), 22 definitive HTTP failure.
health_once() {
	local code
	local -a args=()
	if [[ -n "${SUBSTRATE_HEALTH_CMD:-}" ]]; then
		"${SUBSTRATE_HEALTH_CMD}"
		return $?
	fi
	args=(-sS --max-time "$HEALTH_TIMEOUT" -o /dev/null -w '%{http_code}')
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
	if ! sha=$(resolve_tag "$tag"); then
		exit 1
	fi
	load_units
	build_release "$sha"
	require_release_entries "$ROOT/releases/$sha"
	prepare_health
	if [[ -L "$ROOT/current" ]]; then
		if ! old=$(read_rel "$ROOT/current"); then
			die "refusing current symlink"
		fi
	fi
	swap_link "$ROOT/current" "releases/$sha"
	if ! restart_units || ! health_ok; then
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
