#!/usr/bin/env bash
# Build an immutable release from a tagged commit on main and atomically swap
# /opt/agent-substrate/current. A failed health check points current back at
# the previous release and restarts the units. Only that previous release
# directory is kept.
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
lockdir=""
tmp_link=""
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

load_units() {
	local raw="${SUBSTRATE_RELEASE_UNITS:-substrate-mcp.service substrate-collector-grok.service}"
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

restart_units() {
	local unit status=0
	[[ "$RESTART" == "1" ]] || return 0
	# Called from `if`, where set -e does not stop the loop. Remember every failure.
	for unit in "${units[@]}"; do
		systemctl restart "$unit" || status=1
	done
	return "$status"
}

health_ok() {
	[[ "$RESTART" == "1" ]] || return 0
	if [[ -n "${SUBSTRATE_HEALTH_CMD:-}" ]]; then
		if [[ "${SUBSTRATE_HEALTH_CMD}" != /* || ! -x "${SUBSTRATE_HEALTH_CMD}" ]]; then
			printf '%s\n' "deploy-release: SUBSTRATE_HEALTH_CMD must be an absolute executable path" >&2
			return 1
		fi
		"${SUBSTRATE_HEALTH_CMD}"
		return $?
	fi
	# A bad URL is a failed check, not a hard exit, so current is rolled back.
	if [[ "$HEALTH_URL" == *"@"* || ! "$HEALTH_URL" =~ ^https?://[^[:space:]]+$ ]]; then
		printf '%s\n' "deploy-release: refusing health url" >&2
		return 1
	fi
	curl -fsS --max-time "$HEALTH_TIMEOUT" -o /dev/null -- "$HEALTH_URL"
	return $?
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
	prune_releases "$sha" "$keep_prev"
	printf '%s\n' "current -> releases/$sha"
}

cmd_rollback() {
	local prev="" cur=""
	load_units
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
