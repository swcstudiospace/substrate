#!/usr/bin/env bash
# queue.sh — local JSON queue for offline retry.
#
# Storage: a single JSON array file. Each entry is an object:
#   {"id":"<uuid>","kind":"linear.issue|notion.page","op":"create|update",
#    "key":"<dedup key>","payload":{...},"attempts":0,"next_retry_at":0,
#    "enqueued_at":<epoch>,"last_error":""}
#
# Concurrency: all mutations take an exclusive flock on "${QUEUE_FILE}.lock".
# Requires: jq. No secrets are ever written here (payloads carry content only).
set -euo pipefail

# Configurable queue path. Env-only; default is repo-local and gitignored.
QUEUE_FILE="${SUBSTRATE_SYNC_QUEUE_FILE:-${SUBSTRATE_SYNC_QUEUE_FILE_DEFAULT:-./.substrate-sync-queue.json}}"

_queue_lock_file() {
  printf '%s.lock' "$QUEUE_FILE"
}

# Ensure the queue file exists and holds a JSON array. Repairs corrupt files
# by backing them up and starting empty (never deletes silently).
queue_init() {
  local lock
  lock="$(_queue_lock_file)"
  mkdir -p "$(dirname "$QUEUE_FILE")"
  touch "$lock"
  exec 9>"$lock"
  flock 9
  if [ ! -f "$QUEUE_FILE" ]; then
    printf '[]\n' > "$QUEUE_FILE"
  elif ! jq -e 'type == "array"' "$QUEUE_FILE" >/dev/null 2>&1; then
    local backup
    backup="${QUEUE_FILE}.corrupt.$(date +%s).bak"
    mv "$QUEUE_FILE" "$backup"
    printf '[]\n' > "$QUEUE_FILE"
    echo "queue.sh: corrupt queue backed up to $backup, started empty" >&2
  fi
  flock -u 9
  exec 9>&-
}

# _queue_mutate <jq-filter> — apply filter atomically under lock.
_queue_mutate() {
  local filter="$1"
  local lock tmp
  lock="$(_queue_lock_file)"
  tmp="${QUEUE_FILE}.tmp.$$"
  touch "$lock"
  exec 9>"$lock"
  flock 9
  queue_init_unlocked
  jq "$filter" "$QUEUE_FILE" > "$tmp"
  mv "$tmp" "$QUEUE_FILE"
  flock -u 9
  exec 9>&-
}

# Same as queue_init but assumes the caller already holds the lock.
queue_init_unlocked() {
  mkdir -p "$(dirname "$QUEUE_FILE")"
  if [ ! -f "$QUEUE_FILE" ]; then
    printf '[]\n' > "$QUEUE_FILE"
  elif ! jq -e 'type == "array"' "$QUEUE_FILE" >/dev/null 2>&1; then
    local backup
    backup="${QUEUE_FILE}.corrupt.$(date +%s).bak"
    mv "$QUEUE_FILE" "$backup"
    printf '[]\n' > "$QUEUE_FILE"
    echo "queue.sh: corrupt queue backed up to $backup, started empty" >&2
  fi
}

# _new_id — portable unique id (uuidgen when present, else pid+time+random).
_new_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    printf '%s-%s-%s' "$$" "$(date +%s)" "$RANDOM$RANDOM"
  fi
}

# queue_enqueue <kind> <op> <key> <payload-json>
# Dedup: an entry with the same (kind,key,op) is replaced, not duplicated.
# Prints the entry id.
queue_enqueue() {
  local kind="$1" op="$2" key="$3" payload_json="$4"
  local id now tmp lock
  id="$(_new_id)"
  now="$(date +%s)"
  lock="$(_queue_lock_file)"
  tmp="${QUEUE_FILE}.tmp.$$"
  touch "$lock"
  exec 9>"$lock"
  flock 9
  queue_init_unlocked
  jq --arg kind "$kind" \
     --arg op "$op" \
     --arg key "$key" \
     --argjson payload "$payload_json" \
     --arg id "$id" \
     --argjson now "$now" \
     'map(select(.kind != $kind or .key != $key or .op != $op))
      + [{id: $id, kind: $kind, op: $op, key: $key, payload: $payload,
          attempts: 0, next_retry_at: 0, enqueued_at: $now, last_error: ""}]' \
    "$QUEUE_FILE" > "$tmp"
  mv "$tmp" "$QUEUE_FILE"
  flock -u 9
  exec 9>&-
  printf '%s\n' "$id"
}

# queue_list — print all entries (JSON array) to stdout. Read-only.
queue_list() {
  queue_init
  cat "$QUEUE_FILE"
}

# queue_size — print entry count.
queue_size() {
  queue_init
  jq 'length' "$QUEUE_FILE"
}

# queue_due — print entries whose next_retry_at <= now (JSON array).
queue_due() {
  local now
  now="$(date +%s)"
  queue_init
  jq --argjson now "$now" 'map(select(.next_retry_at <= $now))' "$QUEUE_FILE"
}

# queue_ack <id> — remove entry after successful delivery.
queue_ack() {
  local id="$1"
  _queue_mutate --arg id "$id" 'map(select(.id != $id))'
}

# queue_fail <id> <error> — bump attempts, set exponential backoff for next try.
# Backoff: 2^attempts * BASE seconds, capped at MAX. Jitter-free (deterministic).
queue_fail() {
  local id="$1" error="$2"
  local base max now
  base="${SUBSTRATE_SYNC_RETRY_BASE_SECS:-5}"
  max="${SUBSTRATE_SYNC_RETRY_MAX_SECS:-3600}"
  now="$(date +%s)"
  _queue_mutate --arg id "$id" \
    --arg err "$error" \
    --argjson now "$now" \
    --argjson base "$base" \
    --argjson max "$max" \
    'map(if .id == $id then
           (.attempts += 1)
           | .last_error = $err
           | .next_retry_at = ($now + ([($base * (pow(2; .attempts - 1)) | floor), $max] | min))
         else . end)'
}

# queue_clear — drop all entries. Used by tests and explicit operator action.
queue_clear() {
  _queue_mutate '. = []'
}

# CLI: queue.sh enqueue|list|size|due|ack|fail|clear ...
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cmd="${1:-list}"
  case "$cmd" in
    enqueue)
      # usage: queue.sh enqueue <kind> <op> <key> <payload-json>
      queue_enqueue "$2" "$3" "$4" "$5"
      ;;
    list) queue_list ;;
    size) queue_size ;;
    due) queue_due ;;
    ack) queue_ack "$2" ;;
    fail) queue_fail "$2" "${3:-unknown error}" ;;
    clear) queue_clear ;;
    *)
      echo "usage: queue.sh {enqueue <kind> <op> <key> <payload-json>|list|size|due|ack <id>|fail <id> <error>|clear}" >&2
      exit 2
      ;;
  esac
fi
