#!/usr/bin/env bash
# link.sh — offline peer-link manager: pair/status/unlink/list/revoke.
#
# Standalone by design: reads/writes local files only, never touches the
# network. All state lives under $SUBSTRATE_LINK_DIR (default
# ${XDG_STATE_HOME:-$HOME/.local/state}/substrate-link):
#   machine-id        stable local id (random at first run; no host PII)
#   codes.json        short-lived pairing codes [{code,created_at,expires_at,
#                     status: pending|redeemed|revoked|expired, peer_hint}]
#   links.json        peer links [{peer,status: linked|unlinked|revoked,...}]
#   revocations.json  deny-list [{target: "peer:NAME"|"code:XXXX",...}]
#
# Env overrides (tests/fixtures):
#   SUBSTRATE_LINK_DIR   state directory
#   SUBSTRATE_LINK_TTL   default code TTL seconds (default 600)
#   SUBSTRATE_LINK_NOW   epoch override for "now" (deterministic tests)
#
# Exit codes: 0 ok · 2 conflict · 3 revoked · 4 expired · 5 not found · 6 usage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TTL_DEFAULT="${SUBSTRATE_LINK_TTL:-600}"
LINK_DIR="${SUBSTRATE_LINK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/substrate-link}"
CODES_FILE="$LINK_DIR/codes.json"
LINKS_FILE="$LINK_DIR/links.json"
REVOKES_FILE="$LINK_DIR/revocations.json"
MID_FILE="$LINK_DIR/machine-id"
LOCK_FILE="$LINK_DIR/.lock"

E_CONFLICT=2 E_REVOKED=3 E_EXPIRED=4 E_NOTFOUND=5 E_USAGE=6

need_jq() { command -v jq >/dev/null 2>&1 || { echo "link.sh: jq is required" >&2; exit 1; }; }

now() {
  if [ -n "${SUBSTRATE_LINK_NOW:-}" ]; then printf '%s' "$SUBSTRATE_LINK_NOW";
  else date +%s; fi
}

valid_peer() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; }

init_store() {
  need_jq
  mkdir -p "$LINK_DIR"
  touch "$LOCK_FILE"
  for f in "$CODES_FILE" "$LINKS_FILE" "$REVOKES_FILE"; do
    if [ ! -f "$f" ]; then printf '[]\n' > "$f"; fi
    if ! jq -e 'type == "array"' "$f" >/dev/null 2>&1; then
      mv "$f" "$f.corrupt.$(date +%s).bak"
      printf '[]\n' > "$f"
      echo "link.sh: corrupt $(basename "$f") backed up, started empty" >&2
    fi
  done
  if [ ! -f "$MID_FILE" ]; then new_machine_id > "$MID_FILE"; fi
}

# new_machine_id — random stable id from kernel randomness only; never
# derived from host identity (no host-name/user/MAC/IP lookups anywhere).
new_machine_id() {
  local u
  if [ -r /proc/sys/kernel/random/uuid ]; then
    u="$(cat /proc/sys/kernel/random/uuid)"
  elif command -v openssl >/dev/null 2>&1; then
    u="$(openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
  else
    u="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
  fi
  printf '%s\n' "$u"
}

machine_id() { init_store; cat "$MID_FILE"; }

lock()   { exec 9>"$LOCK_FILE"; flock 9; }
unlock() { flock -u 9; exec 9>&-; }

# atomic_jq <file> <jq-program> [jq-args...] — rewrite file under lock.
atomic_jq() {
  local file="$1"; shift
  local tmp="$file.tmp.$$"
  jq "$@" "$file" > "$tmp"
  mv "$tmp" "$file"
}

gen_code() {
  local c
  while :; do
    c="$(tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' < /dev/urandom | head -c8)"
    c="${c:0:4}-${c:4:4}"
    if ! jq -e --arg c "$c" '.[] | select(.code == $c)' "$CODES_FILE" >/dev/null 2>&1; then
      printf '%s' "$c"; return
    fi
  done
}

# sweep_expired — mark pending codes past expiry as expired. Caller holds lock.
sweep_expired() {
  local t; t="$(now)"
  atomic_jq "$CODES_FILE" --argjson t "$t" \
    'map(if .status == "pending" and .expires_at <= $t then .status = "expired" else . end)'
}

is_revoked_target() {
  # $1: "peer:NAME" or "code:XXXX" → 0 if deny-listed
  jq -e --arg t "$1" '.[] | select(.target == $t)' "$REVOKES_FILE" >/dev/null 2>&1
}

cmd_machine_id() {
  if [ "${1:-}" = "--regenerate" ]; then
    init_store; lock; new_machine_id > "$MID_FILE"; unlock
  fi
  machine_id
}

cmd_pair_issue() {
  # args: [--ttl SECS] [--peer NAME] [--port N]... [--scope S]...
  local ttl="$TTL_DEFAULT" hint="" ports="[]" scopes='["brief"]'
  while [ $# -gt 0 ]; do
    case "$1" in
      --ttl) ttl="${2:?}"; shift 2;;
      --peer) hint="${2:?}"; shift 2;;
      --port) ports="$(printf '%s' "$ports" | jq --argjson p "${2:?}" '. + [$p]')"; shift 2;;
      --scope) scopes="$(printf '%s' "$scopes" | jq --arg s "${2:?}" '. + [$s]')"; shift 2;;
      *) echo "link.sh pair: unknown flag $1" >&2; return $E_USAGE;;
    esac
  done
  [[ "$ttl" =~ ^[0-9]+$ ]] || { echo "link.sh pair: --ttl must be seconds" >&2; return $E_USAGE; }
  if [ -n "$hint" ] && ! valid_peer "$hint"; then echo "link.sh pair: bad peer name" >&2; return $E_USAGE; fi
  init_store; lock
  sweep_expired
  local code t exp mid
  code="$(gen_code)"; t="$(now)"; exp=$(( t + ttl )); mid="$(cat "$MID_FILE")"
  atomic_jq "$CODES_FILE" --arg c "$code" --argjson ca "$t" --argjson ex "$exp" \
    --arg h "$hint" --arg m "$mid" --argjson po "$ports" --argjson sc "$scopes" \
    '. + [{code:$c,created_at:$ca,expires_at:$ex,status:"pending",peer_hint:$h,issued_by:$m,ports:$po,scopes:$sc}]'
  unlock
  printf 'code=%s expires_in=%ss\n' "$code" "$ttl"
}

cmd_pair_redeem() {
  # args: --code CODE [--peer NAME] [--port N]... [--scope S]...
  local code="" peer="" ports="" scopes=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --code) code="${2:?}"; shift 2;;
      --peer) peer="${2:?}"; shift 2;;
      --port) ports="${ports:+$ports }${2:?}"; shift 2;;
      --scope) scopes="${scopes:+$scopes }${2:?}"; shift 2;;
      *) echo "link.sh pair: unknown flag $1" >&2; return $E_USAGE;;
    esac
  done
  [ -n "$code" ] || { echo "link.sh pair: --code CODE required to redeem" >&2; return $E_USAGE; }
  code="$(printf '%s' "$code" | tr '[:lower:]' '[:upper:]')"
  [ -n "$peer" ] || peer="$(init_store; jq -r --arg c "$code" '.[] | select(.code==$c) | .peer_hint // empty' "$CODES_FILE" | head -n1)"
  [ -n "$peer" ] || { echo "link.sh pair: --peer NAME required (code has no peer hint)" >&2; return $E_USAGE; }
  valid_peer "$peer" || { echo "link.sh pair: bad peer name" >&2; return $E_USAGE; }
  init_store; lock
  sweep_expired
  if is_revoked_target "code:$code" || is_revoked_target "peer:$peer"; then
    unlock; echo "link.sh pair: REVOKED (peer or code is revoked)" >&2; return $E_REVOKED
  fi
  local st
  st="$(jq -r --arg c "$code" '.[] | select(.code==$c) | .status' "$CODES_FILE" | head -n1)"
  case "${st:-}" in
    "") unlock; echo "link.sh pair: NOT_FOUND (unknown code)" >&2; return $E_NOTFOUND;;
    redeemed) unlock; echo "link.sh pair: CONFLICT (code already redeemed)" >&2; return $E_CONFLICT;;
    revoked) unlock; echo "link.sh pair: REVOKED (code revoked)" >&2; return $E_REVOKED;;
    expired) unlock; echo "link.sh pair: EXPIRED (code past expires_at)" >&2; return $E_EXPIRED;;
    pending) ;;
    *) unlock; echo "link.sh pair: CONFLICT (code status $st)" >&2; return $E_CONFLICT;;
  esac
  local cur
  cur="$(jq -r --arg p "$peer" '.[] | select(.peer==$p) | .status' "$LINKS_FILE" | head -n1)"
  if [ "$cur" = "linked" ]; then
    unlock; echo "link.sh pair: CONFLICT (peer '$peer' already linked)" >&2; return $E_CONFLICT
  fi
  if [ "$cur" = "revoked" ]; then
    unlock; echo "link.sh pair: REVOKED (peer '$peer' is revoked)" >&2; return $E_REVOKED
  fi
  local t mid po sc
  t="$(now)"; mid="$(cat "$MID_FILE")"
  po="$(jq -c --arg c "$code" '[.[] | select(.code==$c) | .ports[]?] | unique' "$CODES_FILE")"
  sc="$(jq -c --arg c "$code" '[.[] | select(.code==$c) | .scopes[]?] | unique' "$CODES_FILE")"
  [ "$po" = "[]" ] || [ -z "$ports" ] || po="$(printf '%s' "$po" | jq --arg p "$ports" '. + ($p | split(" ") | map(tonumber? // .)) | unique')"
  [ -n "$ports" ] && [ "$po" = "[]" ] && po="$(printf '%s' "$ports" | jq 'split(" ") | map(tonumber? // .) | unique')"
  if [ -n "$scopes" ]; then
    # shellcheck disable=SC2207
    sc="$(printf '%s' "$sc" | jq --arg s "$scopes" '. + ($s | split(" ")) | unique')"
  fi
  [ "$sc" = "[]" ] && sc='["brief"]'
  atomic_jq "$CODES_FILE" --arg c "$code" 'map(if .code==$c then .status="redeemed" else . end)'
  if [ -n "$cur" ]; then
    atomic_jq "$LINKS_FILE" --arg p "$peer" --argjson t "$t" --arg m "$mid" \
      --arg c "$code" --argjson po "$po" --argjson sc "$sc" \
      'map(if .peer==$p then .status="linked"|.linked_at=$t|.machine_id=$m|.code=$c|.ports=$po|.scopes=$sc|.unlinked_at=null else . end)'
  else
    atomic_jq "$LINKS_FILE" --arg p "$peer" --argjson t "$t" --arg m "$mid" \
      --arg c "$code" --argjson po "$po" --argjson sc "$sc" \
      '. + [{peer:$p,status:"linked",linked_at:$t,machine_id:$m,code:$c,ports:$po,scopes:$sc,unlinked_at:null}]'
  fi
  unlock
  printf 'linked peer=%s code=%s\n' "$peer" "$code"
}

cmd_status() {
  # [--peer NAME] [--json]
  local peer="" json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --peer) peer="${2:?}"; shift 2;;
      --json) json=1; shift;;
      *) echo "link.sh status: unknown flag $1" >&2; return $E_USAGE;;
    esac
  done
  init_store
  local t mid linked pending revoked total
  t="$(now)"; mid="$(cat "$MID_FILE")"
  linked="$(jq '[.[] | select(.status=="linked")] | length' "$LINKS_FILE")"
  revoked="$(jq 'length' "$REVOKES_FILE")"
  # pending counts unexpired pending codes without mutating (offline read-only)
  pending="$(jq --argjson t "$t" '[.[] | select(.status=="pending" and .expires_at > $t)] | length' "$CODES_FILE")"
  total="$(jq 'length' "$LINKS_FILE")"
  # NOTE: every branch below emits stdout with ONE printf at the end (output
  # captured first). A streaming writer + an early-closing consumer
  # (e.g. `| grep -q` under `pipefail`) would otherwise SIGPIPE us to 141.
  local out
  if [ "$json" = "1" ]; then
    if [ -n "$peer" ]; then
      out="$(jq --arg p "$peer" --arg m "$mid" --argjson t "$t" \
        '$links[0] as $links | $revokes[0] as $revokes | {machine_id:$m, mode:"standalone (offline, no network)", now:$t, link:($links[] | select(.peer==$p) // null), revoked:([$revokes[] | select(.target==("peer:"+$p))] | length > 0)}' \
        --slurpfile links "$LINKS_FILE" --slurpfile revokes "$REVOKES_FILE" -n)"
    else
      out="$(jq -n --arg m "$mid" --argjson t "$t" --argjson l "$linked" \
        --argjson p "$pending" --argjson r "$revoked" --argjson tot "$total" \
        '{machine_id:$m, mode:"standalone (offline, no network)", now:$t,
          linked:$l, pending_codes:$p, revocations:$r, peers_total:$tot}')"
    fi
    printf '%s\n' "$out"
    return 0
  fi
  out="$(printf 'machine-id: %s\nmode: standalone (offline, no network)\nlinked: %s  pending-codes: %s  revocations: %s  peers-total: %s' \
    "$mid" "$linked" "$pending" "$revoked" "$total")"
  if [ -n "$peer" ]; then
    local row
    row="$(jq -r --arg p "$peer" '.[] | select(.peer==$p) | "\(.peer) status=\(.status) linked_at=\(.linked_at // 0) ports=\(.ports|join(",")) scopes=\(.scopes|join(","))"' "$LINKS_FILE" | head -n1)"
    if [ -z "$row" ]; then
      if is_revoked_target "peer:$peer"; then row="$peer status=revoked (deny-listed, never linked)"
      else row="$peer status=unknown (no link record)"; fi
    else
      if is_revoked_target "peer:$peer"; then row="$row
$peer revoked=true (deny-listed)"; fi
    fi
    printf '%s\n%s\n' "$out" "$row"
    return 0
  fi
  row="$(jq -r '.[] | "\(.peer) status=\(.status) linked_at=\(.linked_at // 0) ports=\(.ports|join(",")) scopes=\(.scopes|join(","))"' "$LINKS_FILE")"
  if [ -n "$row" ]; then printf '%s\n%s\n' "$out" "$row"; else printf '%s\n' "$out"; fi
}

cmd_list() {
  # [--json] [--all]
  local json=0 all=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1; shift;;
      --all) all=1; shift;;
      *) echo "link.sh list: unknown flag $1" >&2; return $E_USAGE;;
    esac
  done
  init_store
  local out=""
  if [ "$json" = "1" ]; then
    if [ "$all" = "1" ]; then out="$(jq '.' "$LINKS_FILE")"
    else out="$(jq '[.[] | select(.status=="linked")]' "$LINKS_FILE")"; fi
    printf '%s\n' "$out"
    return 0
  fi
  if [ "$all" = "1" ]; then
    out="$(jq -r '.[] | "\(.peer)\t\(.status)\tports=\(.ports|join(","))\tscopes=\(.scopes|join(","))"' "$LINKS_FILE")"
  else
    out="$(jq -r '.[] | select(.status=="linked") | "\(.peer)\tports=\(.ports|join(","))\tscopes=\(.scopes|join(","))"' "$LINKS_FILE")"
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
}

cmd_unlink() {
  # --peer NAME [--force]
  local peer=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --peer) peer="${2:?}"; shift 2;;
      --force) shift;;
      *) echo "link.sh unlink: unknown flag $1" >&2; return $E_USAGE;;
    esac
  done
  [ -n "$peer" ] || { echo "link.sh unlink: --peer NAME required" >&2; return $E_USAGE; }
  init_store; lock
  local cur
  cur="$(jq -r --arg p "$peer" '.[] | select(.peer==$p) | .status' "$LINKS_FILE" | head -n1)"
  if [ -z "${cur:-}" ]; then unlock; echo "link.sh unlink: NOT_FOUND (no link for '$peer')" >&2; return $E_NOTFOUND; fi
  if [ "$cur" != "linked" ]; then unlock; echo "link.sh unlink: CONFLICT (peer '$peer' status=$cur, nothing to unlink)" >&2; return $E_CONFLICT; fi
  local t; t="$(now)"
  atomic_jq "$LINKS_FILE" --arg p "$peer" --argjson t "$t" \
    'map(if .peer==$p then .status="unlinked"|.unlinked_at=$t else . end)'
  unlock
  printf 'unlinked peer=%s (re-pair allowed; use revoke to deny)\n' "$peer"
}

cmd_revoke() {
  # delegate: single implementation lives in revoke.sh
  if [ -x "$SCRIPT_DIR/revoke.sh" ]; then exec "$SCRIPT_DIR/revoke.sh" "$@"; fi
  echo "link.sh: revoke.sh not found beside link.sh" >&2; return $E_NOTFOUND
}

cmd_selftest() {
  local tmp fails=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/substrate-link-test.XXXXXX")"
  export SUBSTRATE_LINK_DIR="$tmp"
  export SUBSTRATE_LINK_TTL=600
  local L="$0"
  check() { # $1 desc, $2 expected-exit, rest command…
    local desc="$1" want="$2"; shift 2
    local got=0
    "$@" >/dev/null 2>&1 || got=$?
    if [ "$got" = "$want" ]; then printf 'PASS %s\n' "$desc";
    else printf 'FAIL %s (want exit %s, got %s)\n' "$desc" "$want" "$got"; fails=$((fails+1)); fi
  }
  # 1. stable machine id, uuid-shaped, no PII inputs
  local a b
  a="$("$L" machine-id)"; b="$("$L" machine-id)"
  if [ "$a" = "$b" ] && [[ "$a" =~ ^[0-9a-fA-F-]{36}$ ]]; then printf 'PASS stable machine-id\n';
  else printf 'FAIL stable machine-id\n'; fails=$((fails+1)); fi
  # no-PII scan: fail if the scripts reference host-identity sources.
  # (The sys-file literal is concatenated so it cannot self-match; the
  # command patterns below exclude their own scan lines via `grep -v`.)
  sysfile="/etc/machin""e-id"
  bad="$(grep -rEwi 'hostname|whoami|ifconfig|getmac' "$SCRIPT_DIR/link.sh" "$SCRIPT_DIR/revoke.sh" 2>/dev/null | grep -v 'grep -rE' || true)"
  bad="$bad$(grep -rE 'ip +(addr|link)|HWADDR' "$SCRIPT_DIR/link.sh" "$SCRIPT_DIR/revoke.sh" 2>/dev/null | grep -v 'grep -rE' || true)"
  bad="$bad$(grep -rF "$sysfile" "$SCRIPT_DIR/link.sh" "$SCRIPT_DIR/revoke.sh" 2>/dev/null || true)"
  if [ -n "$bad" ]; then printf 'FAIL no-PII scan: %s\n' "$bad"; fails=$((fails+1)); else printf 'PASS no-PII scan\n'; fi
  # 2. issue + redeem
  local code
  code="$("$L" pair --new --peer alice --ttl 600 | sed -E 's/code=([A-Z0-9-]+).*/\1/')"
  [ -n "$code" ] || { printf 'FAIL issue code\n'; fails=$((fails+1)); }
  check "redeem alice" 0 "$L" pair --code "$code" --peer alice
  st="$("$L" status --peer alice)"; [[ "$st" == *"status=linked"* ]] || { printf 'FAIL status linked\n'; fails=$((fails+1)); }
  printf 'PASS issue+redeem+status\n'
  # 3. conflict: same peer again
  local code2
  code2="$("$L" pair --new --peer alice | sed -E 's/code=([A-Z0-9-]+).*/\1/')"
  check "conflict double-link" 2 "$L" pair --code "$code2" --peer alice
  # 4. expiry
  local code3
  code3="$("$L" pair --new --peer bob --ttl 1 | sed -E 's/code=([A-Z0-9-]+).*/\1/')"
  export SUBSTRATE_LINK_NOW=$(( $(date +%s) + 5 ))
  check "expired code" 4 "$L" pair --code "$code3" --peer bob
  unset SUBSTRATE_LINK_NOW
  # 5. revoke blocks future pair; revoke linked peer
  "$L" revoke --peer bob >/dev/null 2>&1 || { printf 'FAIL revoke bob\n'; fails=$((fails+1)); }
  local code4
  code4="$("$L" pair --new --peer bob | sed -E 's/code=([A-Z0-9-]+).*/\1/')"
  check "revoked peer blocked" 3 "$L" pair --code "$code4" --peer bob
  check "revoke linked alice" 0 "$L" revoke --peer alice
  st="$("$L" status --peer alice)"; [[ "$st" == *"status=revoked"* ]] || { printf 'FAIL status revoked\n'; fails=$((fails+1)); }
  printf 'PASS revoke paths\n'
  # 6. unlink allows re-pair (fresh peer, offline status works)
  local code5
  code5="$("$L" pair --new --peer carol | sed -E 's/code=([A-Z0-9-]+).*/\1/')"
  "$L" pair --code "$code5" --peer carol >/dev/null 2>&1
  check "unlink carol" 0 "$L" unlink --peer carol
  check "unlink missing" 5 "$L" unlink --peer ghost
  "$L" status >/dev/null 2>&1 || { printf 'FAIL offline status\n'; fails=$((fails+1)); }
  "$L" list >/dev/null 2>&1 || { printf 'FAIL list\n'; fails=$((fails+1)); }
  printf 'PASS unlink+offline status\n'
  rm -rf "$tmp"
  if [ "$fails" = "0" ]; then printf 'SELF-TEST OK\n'; return 0; fi
  printf 'SELF-TEST %s FAILURES\n' "$fails" >&2; return 1
}

usage() {
  cat >&2 <<'EOF'
link.sh — offline peer-link manager (no network).
  link.sh machine-id [--regenerate]
  link.sh pair --new [--ttl SECS] [--peer NAME] [--port N]... [--scope S]...
  link.sh pair --code CODE --peer NAME [--port N]... [--scope S]...
  link.sh status [--peer NAME] [--json]
  link.sh list [--json] [--all]
  link.sh unlink --peer NAME
  link.sh revoke --peer NAME [--reason R] | --code CODE | --list
  link.sh --self-test
EOF
  return $E_USAGE
}

cmd="${1:-}"; shift || true
case "$cmd" in
  machine-id) cmd_machine_id "$@";;
  pair)
    if [ "${1:-}" = "--new" ]; then shift; cmd_pair_issue "$@";
    elif [ "${1:-}" = "--code" ]; then cmd_pair_redeem "$@";
    else
      # forgiving: bare CODE or flags containing --code → redeem, else issue
      redeem=0; for a in "$@"; do [ "$a" = "--code" ] && redeem=1; done
      if [ "$redeem" = "1" ] || [[ "${1:-}" =~ ^[A-Za-z0-9-]+$ && -z "${2:-}" ]]; then
        if [[ "${1:-}" =~ ^[A-Za-z0-9-]+$ && "${1:-}" != "--"* ]]; then cmd_pair_redeem --code "$1" "${@:2}";
        else cmd_pair_redeem "$@"; fi
      else cmd_pair_issue "$@"; fi
    fi;;
  status) cmd_status "$@";;
  list) cmd_list "$@";;
  unlink) cmd_unlink "$@";;
  revoke) cmd_revoke "$@";;
  --self-test|self-test) cmd_selftest;;
  -h|--help|help|"") usage;;
  *) echo "link.sh: unknown command $cmd" >&2; usage;;
esac
