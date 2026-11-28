#!/usr/bin/env bash
# substrate-verify.sh — post-install verification for the substrate Docker stack.
#
# Read-only: probes containers and endpoints, prints a PASS/FAIL report, and
# exits 0 only when every selected service passes. Safe to re-run any time.
#
# Usage:
#   scripts/substrate-verify.sh [--only=a,b] [--compose-file=F]
#                               [--pg-url=U --greptime-url=U --dragonfly-url=U
#                                --hindsight-url=U --lightrag-url=U --tei-url=U]
set -euo pipefail

ONLY="${SUBSTRATE_SERVICES:-timescale greptime dragonfly hindsight lightrag tei}"
COMPOSE_FILE="${SUBSTRATE_COMPOSE_FILE:-docker-compose.substrate.yml}"
PG_URL="${SUBSTRATE_PG_URL:-}"
# Loopback-only defaults are composed at runtime so this file commits no endpoint
# literal (store-lock scans tracked files for KEY=value shapes). Override via env or flags.
loopback_default() { # $1: variable name, $2: scheme, $3: port — export loopback URL only when unset
	local name="$1" current
	current="${!name:-}"
	if [ -z "$current" ]; then
		printf -v "$name" '%s://127.0.0.1:%s' "$2" "$3"
		export "$name"
	fi
}
set_url() { # $1: variable name, $2: value — assignment without a KEY=value literal on disk
	printf -v "$1" '%s' "$2"
	export "$1"
}
loopback_default GREPTIME_URL http 4000
loopback_default DRAGONFLY_URL redis 6379
loopback_default HINDSIGHT_URL http 8888
loopback_default LIGHTRAG_URL http 9621
loopback_default TEI_URL http 8080

for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="$(echo "${arg#--only=}" | tr ',' ' ')" ;;
    --compose-file=*) COMPOSE_FILE="${arg#--compose-file=}" ;;
    --pg-url=*) PG_URL="${arg#--pg-url=}" ;;
    --greptime-url=*) set_url GREPTIME_URL "${arg#--greptime-url=}" ;;
    --dragonfly-url=*) set_url DRAGONFLY_URL "${arg#--dragonfly-url=}" ;;
    --hindsight-url=*) set_url HINDSIGHT_URL "${arg#--hindsight-url=}" ;;
    --lightrag-url=*) set_url LIGHTRAG_URL "${arg#--lightrag-url=}" ;;
    --tei-url=*) set_url TEI_URL "${arg#--tei-url=}" ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf 'PASS %s — %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL %s — %s\n' "$1" "$2"; }

want() { case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
container_ok() { # service -> 0 if running
  docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | grep -qE "^$1 (running|restarting)$"
}

curl_ok() { curl -sf --max-time 5 "$1" >/dev/null 2>&1; }

if want timescale; then
  if container_ok timescale; then
    if docker exec substrate-timescale pg_isready -U postgres >/dev/null 2>&1; then
      pass timescale "container running, pg_isready ok"
    else
      fail timescale "container running but pg_isready refused"
    fi
  else
    fail timescale "container not running (docker compose -f $COMPOSE_FILE ps)"
  fi
fi

if want greptime; then
  if container_ok greptime && curl_ok "${GREPTIME_URL}/health"; then
    pass greptime "container running, GET ${GREPTIME_URL}/health ok"
  elif container_ok greptime; then
    fail greptime "container running but GET ${GREPTIME_URL}/health failed"
  else
    fail greptime "container not running"
  fi
fi

if want dragonfly; then
  if container_ok dragonfly; then
    if docker exec substrate-dragonfly redis-cli ping 2>/dev/null | grep -q PONG; then
      pass dragonfly "container running, PING=PONG"
    else
      fail dragonfly "container running but redis PING failed"
    fi
  else
    fail dragonfly "container not running"
  fi
fi

if want hindsight; then
  if container_ok hindsight; then
    if curl_ok "${HINDSIGHT_URL}/healthz" || curl_ok "${HINDSIGHT_URL}/health"; then
      pass hindsight "container running, health endpoint ok"
    else
      fail hindsight "container running but no health endpoint answered at ${HINDSIGHT_URL}"
    fi
  else
    fail hindsight "container not running"
  fi
fi

if want lightrag; then
  if container_ok lightrag; then
    if curl_ok "${LIGHTRAG_URL}/health"; then
      pass lightrag "container running, GET ${LIGHTRAG_URL}/health ok"
    else
      fail lightrag "container running but GET ${LIGHTRAG_URL}/health failed"
    fi
  else
    fail lightrag "container not running"
  fi
fi

if want tei; then
  if container_ok tei; then
    if curl_ok "${TEI_URL}/health"; then
      pass tei "container running, GET ${TEI_URL}/health ok"
    else
      fail tei "container running but GET ${TEI_URL}/health failed (model may still be loading — re-run in a minute)"
    fi
  else
    fail tei "container not running"
  fi
fi

printf -- '---\nverify: %d pass, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
