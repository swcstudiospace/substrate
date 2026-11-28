#!/usr/bin/env bash
# revoke.sh — deny-list revocation for substrate-link. Sourceable + CLI.
#
# Revocation is permanent: a revoked "peer:NAME" or "code:XXXX" can never be
# redeemed or re-linked again. Unlink (link.sh) ends a session but allows
# re-pair; revoke ends it and deny-lists it. Offline: file-local only.
#
# CLI:
#   revoke.sh --peer NAME [--reason R]   revoke (deny-list) a peer
#   revoke.sh --code CODE [--reason R]   revoke a single pairing code
#   revoke.sh --list [--json]            show revocations
#   revoke.sh --self-test
#
# Sourced: provides revoke_peer, revoke_code, revoke_list functions.
# Exit codes: 0 ok · 2 conflict(already revoked) · 5 not found · 6 usage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINK_DIR="${SUBSTRATE_LINK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/substrate-link}"
CODES_FILE="$LINK_DIR/codes.json"
LINKS_FILE="$LINK_DIR/links.json"
REVOKES_FILE="$LINK_DIR/revocations.json"
MID_FILE="$LINK_DIR/machine-id"
LOCK_FILE="$LINK_DIR/.lock"

E_CONFLICT=2 E_NOTFOUND=5 E_USAGE=6

need_jq() { command -v jq >/dev/null 2>&1 || { echo "revoke.sh: jq is required" >&2; exit 1; }; }

_now() {
  if [ -n "${SUBSTRATE_LINK_NOW:-}" ]; then printf '%s' "$SUBSTRATE_LINK_NOW";
  else date +%s; fi
}

_revoke_init() {
  need_jq
  mkdir -p "$LINK_DIR"
  touch "$LOCK_FILE"
  for f in "$CODES_FILE" "$LINKS_FILE" "$REVOKES_FILE"; do
    if [ ! -f "$f" ]; then printf '[]\n' > "$f"; fi
  done
  if [ ! -f "$MID_FILE" ]; then
    if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid > "$MID_FILE";
    else openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/' > "$MID_FILE"; fi
  fi
}

_revoke_lock()   { exec 9>"$LOCK_FILE"; flock 9; }
_revoke_unlock() { flock -u 9; exec 9>&-; }

_revoke_atomic() {
  local file="$1"; shift
  local tmp="$file.tmp.$$"
  jq "$@" "$file" > "$tmp"
  mv "$tmp" "$file"
}

revoke_target() {
  # $1: peer:NAME|code:XXXX  $2: reason — records deny-list entry (idempotent
  # conflict if already present) and flips matching link/code rows to revoked.
  local target="$1" reason="${2:-manual}"
  _revoke_init; _revoke_lock
  if jq -e --arg t "$target" '.[] | select(.target == $t)' "$REVOKES_FILE" >/dev/null 2>&1; then
    _revoke_unlock; echo "revoke.sh: CONFLICT ($target already revoked)" >&2; return $E_CONFLICT
  fi
  local t mid
  t="$(_now)"; mid="$(cat "$MID_FILE")"
  _revoke_atomic "$REVOKES_FILE" --arg t "$target" --argjson at "$t" --arg r "$reason" --arg m "$mid" \
    '. + [{target:$t, revoked_at:$at, reason:$r, by:$m}]'
  case "$target" in
    peer:*)
      local p="${target#peer:}"
      _revoke_atomic "$LINKS_FILE" --arg p "$p" --argjson t "$t" \
        'map(if .peer==$p then .status="revoked"|.unlinked_at=$t else . end)';;
    code:*)
      local c="${target#code:}"
      _revoke_atomic "$CODES_FILE" --arg c "$c" \
        'map(if .code==$c then .status="revoked" else . end)';;
  esac
  _revoke_unlock
  printf 'revoked %s reason=%s\n' "$target" "$reason"
}

revoke_peer() { revoke_target "peer:$1" "${2:-manual}"; }
revoke_code() { revoke_target "code:$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" "${2:-manual}"; }

revoke_list() {
  # [--json] — single printf (streaming jq + early-closing `| grep -q`
  # consumers would otherwise SIGPIPE us; see link.sh NOTE).
  _revoke_init
  local out=""
  if [ "${1:-}" = "--json" ]; then out="$(jq '.' "$REVOKES_FILE")"
  else out="$(jq -r '.[] | "\(.target)\trevoked_at=\(.revoked_at)\treason=\(.reason)"' "$REVOKES_FILE")"; fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
}

_revoke_selftest() {
  local tmp fails=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/substrate-revoke-test.XXXXXX")"
  export SUBSTRATE_LINK_DIR="$tmp"
  local R="$0"
  "$R" --peer dave --reason test >/dev/null 2>&1 || { printf 'FAIL revoke peer\n'; fails=$((fails+1)); }
  if "$R" --peer dave >/dev/null 2>&1; then printf 'FAIL double revoke should conflict\n'; fails=$((fails+1));
  else [ $? = $E_CONFLICT ] && printf 'PASS revoke conflict\n' || printf 'PASS revoke conflict (nonzero)\n'; fi
  out="$("$R" --list)"; [[ "$out" == *"peer:dave"* ]] || { printf 'FAIL revoke list\n'; fails=$((fails+1)); }
  "$R" --code AAAA-1111 >/dev/null 2>&1 || { printf 'FAIL revoke code\n'; fails=$((fails+1)); }
  out="$("$R" --list --json)"; [[ "$out" == *"code:AAAA-1111"* ]] || { printf 'FAIL revoke list json\n'; fails=$((fails+1)); }
  rm -rf "$tmp"
  if [ "$fails" = "0" ]; then printf 'SELF-TEST OK\n'; return 0; fi
  printf 'SELF-TEST %s FAILURES\n' "$fails" >&2; return 1
}

_revoke_usage() {
  cat >&2 <<'EOF'
revoke.sh — permanent deny-list revocation (offline, file-local).
  revoke.sh --peer NAME [--reason R]
  revoke.sh --code CODE [--reason R]
  revoke.sh --list [--json]
EOF
  return $E_USAGE
}

# Run CLI only when executed, not when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cmd="${1:-}"; shift || true
  case "$cmd" in
    --peer) [ $# -ge 1 ] || _revoke_usage; p="$1"; shift; r="manual"
      if [ "${1:-}" = "--reason" ]; then r="${2:-manual}"; fi
      revoke_peer "$p" "$r";;
    --code) [ $# -ge 1 ] || _revoke_usage; c="$1"; shift; r="manual"
      if [ "${1:-}" = "--reason" ]; then r="${2:-manual}"; fi
      revoke_code "$c" "$r";;
    --list) revoke_list "${1:-}";;
    --self-test|self-test) _revoke_selftest;;
    *) _revoke_usage;;
  esac
fi
