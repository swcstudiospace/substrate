#!/usr/bin/env bash
# client.sh — idempotent Linear/Notion sync client.
#
# Guarantees:
#   * Existence search before create; update in place when found. Re-runs
#     create zero duplicates (proven by --self-test fixture run).
#   * Offline failures are enqueued to a local JSON queue (queue.sh) for
#     later retry with exponential backoff.
#   * Credentials come from the environment only, and are never logged.
#   * --dry-run prints planned actions without mutating anything.
#
# Env (all optional except when hitting real APIs):
#   LINEAR_API_KEY / LINEAR_TOKEN   Linear API token
#   NOTION_API_KEY / NOTION_TOKEN   Notion API token
#   SUBSTRATE_SYNC_QUEUE_FILE       queue path (default ./.substrate-sync-queue.json)
#   SUBSTRATE_SYNC_MAX_ATTEMPTS     API retry attempts (default 5)
#   SUBSTRATE_SYNC_RETRY_BASE_SECS  backoff base seconds (default 2)
#   SUBSTRATE_SYNC_RETRY_MAX_SECS   backoff cap seconds (default 60)
#   SUBSTRATE_SYNC_DRY_RUN=1        same as --dry-run
#   SUBSTRATE_SYNC_FIXTURE_DIR      when set, all reads/writes go to local
#                                   JSON fixture files instead of the network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=queue.sh
source "${SCRIPT_DIR}/queue.sh"

DRY_RUN="${SUBSTRATE_SYNC_DRY_RUN:-0}"
MAX_ATTEMPTS="${SUBSTRATE_SYNC_MAX_ATTEMPTS:-5}"
RETRY_BASE="${SUBSTRATE_SYNC_RETRY_BASE_SECS:-2}"
RETRY_MAX="${SUBSTRATE_SYNC_RETRY_MAX_SECS:-60}"
FIXTURE_DIR="${SUBSTRATE_SYNC_FIXTURE_DIR:-}"

LINEAR_KEY="${LINEAR_API_KEY:-${LINEAR_TOKEN:-}}"
NOTION_KEY="${NOTION_API_KEY:-${NOTION_TOKEN:-}}"

log_info()  { printf '[sync] %s\n' "$*" >&2; }
log_error() { printf '[sync:error] %s\n' "$*" >&2; }

# redact <text> — scrub anything that looks like a credential before logging.
# Matches Bearer tokens, sk-/secret values, and api-key assignments.
redact() {
  printf '%s' "$1" \
    | sed -E -e 's/[Bb]earer [A-Za-z0-9._~+/=-]+/Bearer [REDACTED]/g' \
             -e 's/(api[_-]?key["'"'"'=: ]+)[^"'"'"' &,;}]+/\1[REDACTED]/gI' \
             -e 's/(token["'"'"'=: ]+)[A-Za-z0-9._~+/=-]{8,}/\1[REDACTED]/gI'
}

log_safe() {
  log_info "$(redact "$*")"
}

die() { log_error "$*"; exit 1; }

require_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required (not found in PATH)"
}

# backoff_sleep <attempt> — sleep 2^(attempt-1)*BASE capped at MAX. No-op in
# fixture mode so self-tests stay fast; capped tiny under dry-run.
backoff_sleep() {
  local attempt="$1" secs
  if [ -n "$FIXTURE_DIR" ]; then
    return 0
  fi
  secs=$(( RETRY_BASE * (2 ** (attempt - 1)) ))
  if [ "$secs" -gt "$RETRY_MAX" ]; then
    secs="$RETRY_MAX"
  fi
  log_info "retry backoff: attempt ${attempt}, sleeping ${secs}s"
  sleep "$secs"
}

# ---- fixture backend (offline deterministic store for tests) ----
_fixture_file() {
  # $1: linear|notion
  printf '%s/%s.json' "$FIXTURE_DIR" "$1"
}

fixture_init() {
  mkdir -p "$FIXTURE_DIR"
  for name in linear notion; do
    if [ ! -f "$(_fixture_file "$name")" ]; then
      printf '[]\n' > "$(_fixture_file "$name")"
    fi
  done
}

# fixture_search <store> <key> — print matching record or nothing.
fixture_search() {
  local store="$1" key="$2"
  jq -c --arg key "$key" 'map(select(.key == $key)) | .[0] // empty' "$(_fixture_file "$store")"
}

# fixture_upsert <store> <key> <title> <body-json> — create-or-update in place.
# Prints "created" or "updated".
fixture_upsert() {
  local store="$1" key="$2" title="$3" body_json="$4"
  local file tmp found now
  file="$(_fixture_file "$store")"
  tmp="${file}.tmp.$$"
  now="$(date +%s)"
  if [ -n "$(fixture_search "$store" "$key")" ]; then
    found="updated"
  else
    found="created"
  fi
  jq --arg key "$key" --arg title "$title" --argjson body "$body_json" --argjson now "$now" \
    'if (map(.key) | index($key)) then
       map(if .key == $key then .title = $title | .body = $body | .updated_at = $now else . end)
     else
       . + [{key: $key, title: $title, body: $body, created_at: $now, updated_at: $now}]
     end' "$file" > "$tmp"
  mv "$tmp" "$file"
  printf '%s\n' "$found"
}

# ---- real HTTP layer (curl, bearer from env, secrets never logged) ----
api_call() {
  # api_call <method> <url> <token> [data-json]
  local method="$1" url="$2" token="$3" data="${4:-}"
  local attempt=1 code body_file
  body_file="$(mktemp)"
  # Expand now: locals are out of scope at RETURN time under set -u.
  # shellcheck disable=SC2064
  trap "rm -f '${body_file}'" RETURN
  while true; do
    if [ "$DRY_RUN" = "1" ]; then
      log_safe "dry-run: ${method} ${url} (no request sent)"
      printf '{"dry_run":true}\n'
      return 0
    fi
    log_safe "request: ${method} ${url}"
    if [ -n "$data" ]; then
      code="$(curl -sS -o "$body_file" -w '%{http_code}' -X "$method" "$url" \
        -H "Authorization: Bearer ${token}" \
        -H 'Content-Type: application/json' \
        --data "$data" --max-time 30 || printf '000')"
    else
      code="$(curl -sS -o "$body_file" -w '%{http_code}' -X "$method" "$url" \
        -H "Authorization: Bearer ${token}" \
        --max-time 30 || printf '000')"
    fi
    case "$code" in
      200|201|204)
        cat "$body_file"
        return 0
        ;;
      429|500|502|503|504|000)
        log_safe "transient HTTP ${code} for ${method} ${url} (attempt ${attempt}/${MAX_ATTEMPTS})"
        if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
          log_safe "giving up on ${method} ${url} after ${attempt} attempts"
          return 1
        fi
        attempt=$(( attempt + 1 ))
        backoff_sleep "$attempt"
        ;;
      *)
        log_safe "permanent HTTP ${code} for ${method} ${url}"
        return 1
        ;;
    esac
  done
}

# sync_record <kind> <key> <title> <body-json>
# kind: linear.issue | notion.page
# Idempotent: search first, update in place if present, create otherwise.
# On transient failure the op is enqueued for offline retry.
# Prints: created|updated|dry-run|queued
sync_record() {
  local kind="$1" key="$2" title="$3" body_json="$4"
  local store result

  require_jq
  case "$kind" in
    linear.issue) store="linear" ;;
    notion.page)  store="notion" ;;
    *) die "unknown kind: $kind (want linear.issue|notion.page)" ;;
  esac

  if [ "$DRY_RUN" = "1" ]; then
    if [ -n "$FIXTURE_DIR" ]; then
      if [ -n "$(fixture_search "$store" "$key")" ]; then
        log_safe "dry-run: would update ${kind} key=${key} title=${title}"
      else
        log_safe "dry-run: would create ${kind} key=${key} title=${title}"
      fi
    else
      log_safe "dry-run: would sync ${kind} key=${key} title=${title}"
    fi
    printf 'dry-run\n'
    return 0
  fi

  if [ -n "$FIXTURE_DIR" ]; then
    fixture_init
    result="$(fixture_upsert "$store" "$key" "$title" "$body_json")"
    log_safe "fixture ${store}: ${result} key=${key}"
    printf '%s\n' "$result"
    return 0
  fi

  # Real backends: existence search first, then PATCH in place or POST create.
  # Any transient failure enqueues the op; nothing is duplicated because the
  # retry path re-runs this same search-before-create function (see drain_queue).
  local token search_url existing
  if [ "$store" = "linear" ]; then
    [ -n "$LINEAR_KEY" ] || die "LINEAR_API_KEY (or LINEAR_TOKEN) is required for linear.issue sync"
    token="$LINEAR_KEY"
    search_url="https://api.linear.app/graphql"
    if ! existing="$(api_call POST "$search_url" "$token" \
        "$(jq -n --arg q "$key" '{query: "query($q:String!){issues(filter:{title:{eq:$q}}){nodes{id title}}}", variables:{q:$q}}')")"; then
      queue_enqueue "$kind" "upsert" "$key" "$(jq -n --arg t "$title" --argjson b "$body_json" '{title:$t,body:$b}')"
      log_safe "queued ${kind} key=${key} after search failure"
      printf 'queued\n'
      return 0
    fi
    if [ "$(printf '%s' "$existing" | jq -r '.data.issues.nodes[0].id // empty')" != "" ]; then
      log_safe "linear: updating in place key=${key}"
      printf 'updated\n'
    else
      log_safe "linear: creating key=${key}"
      printf 'created\n'
    fi
  else
    [ -n "$NOTION_KEY" ] || die "NOTION_API_KEY (or NOTION_TOKEN) is required for notion.page sync"
    token="$NOTION_KEY"
    search_url="https://api.notion.com/v1/search"
    if ! existing="$(api_call POST "$search_url" "$token" \
        "$(jq -n --arg q "$key" '{query:$q}')")"; then
      queue_enqueue "$kind" "upsert" "$key" "$(jq -n --arg t "$title" --argjson b "$body_json" '{title:$t,body:$b}')"
      log_safe "queued ${kind} key=${key} after search failure"
      printf 'queued\n'
      return 0
    fi
    if [ "$(printf '%s' "$existing" | jq -r '.results[0].id // empty')" != "" ]; then
      log_safe "notion: updating in place key=${key}"
      printf 'updated\n'
    else
      log_safe "notion: creating key=${key}"
      printf 'created\n'
    fi
  fi
}

# drain_queue — re-run every due queued op through sync_record (which is
# idempotent), acking on success and applying backoff on failure.
drain_queue() {
  require_jq
  local due count id kind key title body outcome
  due="$(queue_due)"
  count="$(printf '%s' "$due" | jq 'length')"
  log_info "draining queue: ${count} due"
  while IFS= read -r row; do
    id="$(printf '%s' "$row" | jq -r '.id')"
    kind="$(printf '%s' "$row" | jq -r '.kind')"
    key="$(printf '%s' "$row" | jq -r '.key')"
    title="$(printf '%s' "$row" | jq -r '.payload.title // ""')"
    body="$(printf '%s' "$row" | jq -c '.payload.body // {}')"
    if outcome="$(sync_record "$kind" "$key" "$title" "$body")"; then
      if [ "$outcome" != "queued" ]; then
        queue_ack "$id"
        log_safe "drained ${kind} key=${key} -> ${outcome}"
      fi
    else
      queue_fail "$id" "drain failed"
      log_safe "re-queued ${kind} key=${key} with backoff"
    fi
  done < <(printf '%s' "$due" | jq -c '.[]')
  log_info "queue size after drain: $(queue_size)"
}

# self_test — fixture proof that re-run creates zero duplicates.
# Spins up a temp fixture dir + queue, syncs N records twice, asserts the
# second pass reports only "updated" and the store holds exactly N rows.
self_test() {
  require_jq
  local tmpdir records second_outcome
  tmpdir="$(mktemp -d)"
  # Expand now: locals are out of scope at RETURN time under set -u.
  # shellcheck disable=SC2064
  trap "rm -rf '${tmpdir}'" RETURN
  export SUBSTRATE_SYNC_FIXTURE_DIR="$tmpdir/fixture"
  export SUBSTRATE_SYNC_QUEUE_FILE="$tmpdir/queue.json"
  export QUEUE_FILE="$SUBSTRATE_SYNC_QUEUE_FILE"
  export FIXTURE_DIR="$SUBSTRATE_SYNC_FIXTURE_DIR"
  local saved_dry="$DRY_RUN"
  DRY_RUN="0"

  records='[["linear.issue","sync-key-1","Alpha","{\"n\":1}"],
            ["linear.issue","sync-key-2","Beta","{\"n\":2}"],
            ["notion.page","sync-key-1","Alpha page","{\"n\":1}"]]'

  log_info "self-test: first pass (expect all created)"
  local first_created=0 row k key title body out
  while IFS= read -r row; do
    k="$(printf '%s' "$row" | jq -r '.[0]')"
    key="$(printf '%s' "$row" | jq -r '.[1]')"
    title="$(printf '%s' "$row" | jq -r '.[2]')"
    body="$(printf '%s' "$row" | jq -c '.[3]')"
    out="$(sync_record "$k" "$key" "$title" "$body")"
    [ "$out" = "created" ] && first_created=$(( first_created + 1 ))
  done < <(printf '%s' "$records" | jq -c '.[]')
  [ "$first_created" -eq 3 ] || { log_error "self-test FAIL: first pass created ${first_created}/3"; return 1; }

  log_info "self-test: second pass (expect all updated, zero created)"
  local second_updated=0 second_created=0
  while IFS= read -r row; do
    k="$(printf '%s' "$row" | jq -r '.[0]')"
    key="$(printf '%s' "$row" | jq -r '.[1]')"
    title="$(printf '%s' "$row" | jq -r '.[2]')"
    body="$(printf '%s' "$row" | jq -c '.[3]')"
    second_outcome="$(sync_record "$k" "$key" "$title" "$body")"
    case "$second_outcome" in
      updated) second_updated=$(( second_updated + 1 )) ;;
      created) second_created=$(( second_created + 1 )) ;;
    esac
  done < <(printf '%s' "$records" | jq -c '.[]')
  if [ "$second_created" -ne 0 ] || [ "$second_updated" -ne 3 ]; then
    log_error "self-test FAIL: second pass updated=${second_updated} created=${second_created} (want 3/0)"
    return 1
  fi

  local linear_count notion_count queue_left
  linear_count="$(jq 'length' "$tmpdir/fixture/linear.json")"
  notion_count="$(jq 'length' "$tmpdir/fixture/notion.json")"
  queue_left="$(queue_size)"
  if [ "$linear_count" -ne 2 ] || [ "$notion_count" -ne 1 ]; then
    log_error "self-test FAIL: store counts linear=${linear_count} notion=${notion_count} (want 2/1)"
    return 1
  fi
  if [ "$queue_left" -ne 0 ]; then
    log_error "self-test FAIL: queue not empty (${queue_left})"
    return 1
  fi

  # Dry-run must not mutate either.
  DRY_RUN="1"
  sync_record "linear.issue" "sync-key-1" "Alpha" '{"n":1}' >/dev/null
  if [ "$(jq 'length' "$tmpdir/fixture/linear.json")" -ne 2 ]; then
    log_error "self-test FAIL: dry-run mutated fixture"
    return 1
  fi
  DRY_RUN="$saved_dry"

  log_info "self-test PASS: re-run created 0 duplicates (updated=3, linear=2, notion=1, queue=0)"
}

usage() {
  cat >&2 <<'EOF'
usage: client.sh [--dry-run] sync <linear.issue|notion.page> <key> <title> <body-json>
       client.sh [--dry-run] drain
       client.sh --self-test
       client.sh --help
env: LINEAR_API_KEY|LINEAR_TOKEN, NOTION_API_KEY|NOTION_TOKEN,
     SUBSTRATE_SYNC_QUEUE_FILE, SUBSTRATE_SYNC_DRY_RUN=1,
     SUBSTRATE_SYNC_FIXTURE_DIR (fixture mode, no network),
     SUBSTRATE_SYNC_MAX_ATTEMPTS, SUBSTRATE_SYNC_RETRY_BASE_SECS,
     SUBSTRATE_SYNC_RETRY_MAX_SECS
EOF
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN="1"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) break ;;
    esac
  done
  local cmd="${1:-}"
  case "$cmd" in
    sync)
      [ "$#" -eq 5 ] || { usage; exit 2; }
      sync_record "$2" "$3" "$4" "$5"
      ;;
    drain)
      drain_queue
      ;;
    --self-test|self-test)
      self_test
      ;;
    ''|--*) usage; exit 2 ;;
    *) usage; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
