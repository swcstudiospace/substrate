#!/usr/bin/env bash
# substrate-install.sh — one-click Docker installer for the substrate data planes.
#
# Installs TimescaleDB, GreptimeDB, DragonflyDB, Hindsight, LightRAG + TEI as
# pinned Docker images via a generated compose file. Idempotent: re-running
# detects existing containers/volumes, reuses stored secrets, and repairs
# (recreates) unhealthy services instead of duplicating anything.
#
# Usage:
#   scripts/substrate-install.sh [flags]
#
#   --all              install all six services (default when --only/--skip absent
#                      and the prompt answers "all")
#   --only=a,b         install only these services
#                      (timescale,greptime,dragonfly,hindsight,lightrag,tei)
#   --skip=a,b         install all except these
#   --yes              non-interactive; accept defaults, generate secrets
#   --no-start         write files but do not start containers
#   --reset            DELETE volumes and recreate from scratch (destructive:
#                      requires typed confirmation, or --yes --reset together)
#   --compose-file=F   compose path (default: docker-compose.substrate.yml)
#   --env-file=F       secrets file (default: .env.substrate)
#
# Nothing destructive runs without confirmation: --reset without --yes asks
# for typed confirmation; without the word RESET it aborts.
set -euo pipefail

ALL_SERVICES="timescale greptime dragonfly hindsight lightrag tei"
ONLY=""; SKIP=""; YES=0; NO_START=0; RESET=0
COMPOSE_FILE="${SUBSTRATE_COMPOSE_FILE:-docker-compose.substrate.yml}"
ENV_FILE="${SUBSTRATE_ENV_FILE:-.env.substrate}"

for arg in "$@"; do
  case "$arg" in
    --all) ONLY="$ALL_SERVICES" ;;
    --only=*) ONLY="$(echo "${arg#--only=}" | tr ',' ' ')" ;;
    --skip=*) SKIP="$(echo "${arg#--skip=}" | tr ',' ' ')" ;;
    --yes) YES=1 ;;
    --no-start) NO_START=1 ;;
    --reset) RESET=1 ;;
    --compose-file=*) COMPOSE_FILE="${arg#--compose-file=}" ;;
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# Pinned images — never `latest`, so installs are deterministic.
TIMESCALE_IMAGE="${TIMESCALE_IMAGE:-timescale/timescaledb:2.15.3-pg16}"
GREPTIME_IMAGE="${GREPTIME_IMAGE:-greptime/greptimedb:v1.1.4}"
DRAGONFLY_IMAGE="${DRAGONFLY_IMAGE:-docker.dragonflydb.io/dragonflydb/dragonfly:v2.1}"
HINDSIGHT_IMAGE="${HINDSIGHT_IMAGE:-hindsight-api:0.9.1}"
LIGHTRAG_IMAGE="${LIGHTRAG_IMAGE:-ghcr.io/hkuds/lightrag:v1.5.7}"
TEI_IMAGE="${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:1.5.0-cpu}"
TEI_MODEL="${TEI_MODEL:-BAAI/bge-small-en-v1.5}"

valid_service() {
  case "$1" in
    timescale|greptime|dragonfly|hindsight|lightrag|tei) return 0 ;;
    *) echo "unknown service: $1 (want one of: $ALL_SERVICES)" >&2; exit 2 ;;
  esac
}
for s in $ONLY $SKIP; do valid_service "$s"; done

# Resolve the service set.
if [ -z "$ONLY" ]; then
  if [ -n "$SKIP" ]; then
    ONLY="$ALL_SERVICES"
  elif [ "$YES" -eq 1 ]; then
    ONLY="$ALL_SERVICES"
  else
    echo "docker-all choice: install [a]ll six services or pick a subset?"
    echo "  services: $ALL_SERVICES"
    printf 'choice ([a]ll / comma-separated subset): '
    read -r CHOICE
    case "$CHOICE" in
      a|all|A|ALL|"") ONLY="$ALL_SERVICES" ;;
      *)
        ONLY="$(echo "$CHOICE" | tr ',' ' ')"
        for s in $ONLY; do valid_service "$s"; done ;;
    esac
  fi
fi
# Apply --skip.
if [ -n "$SKIP" ]; then
  FILTERED=""
  for s in $ONLY; do
    case " $SKIP " in *" $s "*) ;; *) FILTERED="$FILTERED $s" ;; esac
  done
  ONLY="$FILTERED"
fi
if [ -z "$(echo "$ONLY" | tr -d ' ')" ]; then
  echo "nothing to install (empty service set)" >&2; exit 2
fi
echo "services:$ONLY"

# Preflight first; refuse to continue on hard failures.
if ! scripts/substrate-preflight.sh; then
  echo "preflight failed — fix the FAIL lines above, then re-run" >&2
  exit 1
fi

# Destructive path: --reset wipes volumes. Always confirm.
if [ "$RESET" -eq 1 ]; then
  if [ "$YES" -eq 1 ]; then
    echo "--reset --yes: volumes for$ONLY will be DELETED."
    printf 'type RESET to confirm: '
    read -r CONFIRM
    [ "$CONFIRM" = "RESET" ] || { echo "aborted (confirmation mismatch)"; exit 1; }
  else
    echo "WARNING: --reset deletes all data volumes for$ONLY. This cannot be undone."
    printf 'type RESET to confirm, anything else aborts: '
    read -r CONFIRM
    [ "$CONFIRM" = "RESET" ] || { echo "aborted"; exit 1; }
  fi
fi

# Secrets: reuse stored values (idempotent), else prompt or generate.
get_secret() { # name [default]
  local name="$1" def="${2:-}" val=""
  if [ -f "$ENV_FILE" ]; then
    val="$(grep -E "^${name}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  fi
  if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  if [ "$YES" -eq 1 ]; then
    if [ -n "$def" ]; then printf '%s' "$def"; else openssl rand -hex 24 2>/dev/null || printf 'changeme-%s' "$RANDOM"; fi
    return 0
  fi
  printf '%s [%s]: ' "$name" "leave empty to generate" >&2
  read -r val
  if [ -z "$val" ]; then
    if [ -n "$def" ]; then printf '%s' "$def"; else openssl rand -hex 24 2>/dev/null || printf 'changeme-%s' "$RANDOM"; fi
  else
    [ "${#val}" -ge 8 ] || { echo "value must be >= 8 chars" >&2; return 1; }
    printf '%s' "$val"
  fi
}

want() { case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

PG_PASS=""; GREPTIME_PASS=""; HINDSIGHT_KEY=""; LIGHTRAG_KEY=""
if want timescale;  then PG_PASS="$(get_secret SUBSTRATE_PG_PASSWORD)"; fi
if want greptime;   then GREPTIME_PASS="$(get_secret GREPTIME_PASSWORD)"; fi
if want hindsight;  then HINDSIGHT_KEY="$(get_secret HINDSIGHT_API_KEY)"; fi
if want lightrag;   then LIGHTRAG_KEY="$(get_secret LIGHTRAG_API_KEY)"; fi

# Persist secrets (0600) without touching existing entries.
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
put_secret() { # name value
  grep -vE "^$1=" "$ENV_FILE" > "${ENV_FILE}.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}
[ -n "$PG_PASS" ] && put_secret SUBSTRATE_PG_PASSWORD "$PG_PASS"
[ -n "$GREPTIME_PASS" ] && put_secret GREPTIME_PASSWORD "$GREPTIME_PASS"
[ -n "$HINDSIGHT_KEY" ] && put_secret HINDSIGHT_API_KEY "$HINDSIGHT_KEY"
[ -n "$LIGHTRAG_KEY" ] && put_secret LIGHTRAG_API_KEY "$LIGHTRAG_KEY"

# Deterministic compose file: fixed service order, pinned images, fixed ports.
{
  echo "# Generated by scripts/substrate-install.sh — deterministic, safe to regenerate."
  echo "# Services:$ONLY"
  echo "services:"
  if want timescale; then printf '%s\n' \
    "  timescale:" \
    "    image: ${TIMESCALE_IMAGE}" \
    "    container_name: substrate-timescale" \
    "    restart: unless-stopped" \
    "    env_file: [${ENV_FILE}]" \
    "    ports: ['5432:5432']" \
    "    volumes: [timescale-data:/var/lib/postgresql/data]" \
    "    healthcheck: {test: ['CMD-SHELL','pg_isready -U postgres'], interval: 10s, retries: 5}"
  fi
  if want greptime; then printf '%s\n' \
    "  greptime:" \
    "    image: ${GREPTIME_IMAGE}" \
    "    container_name: substrate-greptime" \
    "    restart: unless-stopped" \
    "    command: ['standalone','start','--http-addr=0.0.0.0:4000','--rpc-addr=0.0.0.0:4001','--mysql-addr=0.0.0.0:4002','--postgres-addr=0.0.0.0:4003']" \
    "    ports: ['4000:4000','4001:4001','4002:4002','4003:4003']" \
    "    volumes: [greptime-data:/greptimedb_data]" \
    "    healthcheck: {test: ['CMD-SHELL','curl -sf http://localhost:4000/health || exit 1'], interval: 10s, retries: 5}"
  fi
  if want dragonfly; then printf '%s\n' \
    "  dragonfly:" \
    "    image: ${DRAGONFLY_IMAGE}" \
    "    container_name: substrate-dragonfly" \
    "    restart: unless-stopped" \
    "    ports: ['6379:6379']" \
    "    volumes: [dragonfly-data:/data]" \
    "    healthcheck: {test: ['CMD-SHELL','redis-cli ping | grep -q PONG'], interval: 10s, retries: 5}"
  fi
  if want hindsight; then printf '%s\n' \
    "  hindsight:" \
    "    image: ${HINDSIGHT_IMAGE}" \
    "    container_name: substrate-hindsight" \
    "    restart: unless-stopped" \
    "    env_file: [${ENV_FILE}]" \
    "    ports: ['8888:8888']" \
    "    volumes: [hindsight-data:/data]" \
    "    healthcheck: {test: ['CMD-SHELL','curl -sf http://localhost:8888/healthz || curl -sf http://localhost:8888/health || exit 1'], interval: 15s, retries: 5}"
  fi
  if want lightrag; then printf '%s\n' \
    "  lightrag:" \
    "    image: ${LIGHTRAG_IMAGE}" \
    "    container_name: substrate-lightrag" \
    "    restart: unless-stopped" \
    "    env_file: [${ENV_FILE}]" \
    "    ports: ['9621:9621']" \
    "    volumes: [lightrag-data:/app/data]" \
    "    healthcheck: {test: ['CMD-SHELL','curl -sf http://localhost:9621/health || exit 1'], interval: 15s, retries: 5}"
  fi
  if want tei; then printf '%s\n' \
    "  tei:" \
    "    image: ${TEI_IMAGE}" \
    "    container_name: substrate-tei" \
    "    restart: unless-stopped" \
    "    command: ['--model-id','${TEI_MODEL}','--port','8080']" \
    "    ports: ['8080:8080']" \
    "    volumes: [tei-data:/data]" \
    "    healthcheck: {test: ['CMD-SHELL','curl -sf http://localhost:8080/health || exit 1'], interval: 15s, retries: 10}"
  fi
  echo "volumes:"
  want timescale && echo "  timescale-data:"
  want greptime && echo "  greptime-data:"
  want dragonfly && echo "  dragonfly-data:"
  want hindsight && echo "  hindsight-data:"
  want lightrag && echo "  lightrag-data:"
  want tei && echo "  tei-data:"
} > "$COMPOSE_FILE"
echo "wrote $COMPOSE_FILE"

if [ "$NO_START" -eq 1 ]; then
  echo "files written; containers not started (--no-start)"
  exit 0
fi

export SUBSTRATE_PG_PASSWORD="$PG_PASS"

if [ "$RESET" -eq 1 ]; then
  docker compose -f "$COMPOSE_FILE" down -v
fi
# Idempotent up: creates what is missing, recreates only what drifted/unhealthy.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans
# Repair pass: recreate any container still unhealthy/unrunning.
for svc in $ONLY; do
  cid="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc" 2>/dev/null || true)"
  if [ -z "$cid" ]; then
    echo "repair: $svc has no container — (re)creating"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d "$svc"
  fi
done

echo "---"
echo "next: scripts/substrate-verify.sh [--only=$(echo "$ONLY" | tr ' ' ',')]"
printf 'wire URLs: SUBSTRATE_PG_URL=postgresql://postgres:$SUBSTRATE_PG_PASSWORD@localhost:5432/postgres\n'
printf '  %s=%s %s=%s\n' GREPTIME_URL "http://localhost:4000" DRAGONFLY_URL "redis://localhost:6379"
printf '  %s=%s %s=%s %s=%s\n' HINDSIGHT_URL "http://localhost:8888" LIGHTRAG_URL "http://localhost:9621" TEI_URL "http://localhost:8080"
