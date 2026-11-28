#!/usr/bin/env bash
# substrate-preflight.sh — environment checks for the substrate Docker installer.
#
# Read-only: changes nothing. Prints a PASS/WARN/FAIL report and exits 0 when
# every hard requirement passes, 1 otherwise. Warnings never fail unless
# --strict is given.
#
# Usage:
#   scripts/substrate-preflight.sh [--strict] [--quiet]
#
# Env overrides (all optional):
#   SUBSTRATE_COMPOSE_FILE   compose file the installer would manage
#                            (default: docker-compose.substrate.yml)
set -euo pipefail

STRICT=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '1,12p' "$0"
      exit 0 ;;
    *)
      echo "unknown flag: $arg (see --help)" >&2
      exit 2 ;;
  esac
done

COMPOSE_FILE="${SUBSTRATE_COMPOSE_FILE:-docker-compose.substrate.yml}"
PASS=0; WARN=0; FAIL=0

log() { [ "$QUIET" -eq 1 ] && [ "$1" = "PASS" ] || true; [ "$QUIET" -eq 0 ] && printf '%-5s %s\n' "$1" "$2" || true; }
ok()   { PASS=$((PASS+1)); log PASS "$1"; }
warn() { WARN=$((WARN+1)); log WARN "$1"; }
fail() { FAIL=$((FAIL+1)); log FAIL "$1"; }

# --- 1. OS / arch ------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
ok "os/arch: ${OS}/${ARCH}"

# --- 2. docker engine ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "docker CLI not found (install Docker Desktop or docker engine first)"
else
  if DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; then
    ok "docker engine reachable (server ${DOCKER_VER})"
  else
    fail "docker CLI present but daemon unreachable (is dockerd running?)"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose plugin available ($(docker compose version --short 2>/dev/null || echo ok))"
  else
    fail "docker compose plugin missing (need Docker Compose v2)"
  fi
fi

# --- 3. ports ----------------------------------------------------------------
# Must stay in sync with scripts/substrate-install.sh SERVICE_PORTS.
check_port() {
  local name="$1" port="$2"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"; then
      fail "port ${port} (${name}) already in use"
    else
      ok "port ${port} (${name}) free"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      fail "port ${port} (${name}) already in use"
    else
      ok "port ${port} (${name}) free"
    fi
  else
    warn "cannot probe ports (no ss/lsof); assuming 5432,4000-4003,6379,8080,8888,9621 free"
  fi
}
check_port timescale 5432
check_port greptime-http 4000
check_port greptime-rpc 4001
check_port greptime-mysql 4002
check_port greptime-pg 4003
check_port dragonfly 6379
check_port tei 8080
check_port hindsight 8888
check_port lightrag 9621

# --- 4. disk / memory ---------------------------------------------------------
if command -v df >/dev/null 2>&1; then
  FREE_KB="$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -gt 0 ] 2>/dev/null; then
    if [ "$FREE_KB" -ge 5242880 ]; then
      ok "disk free $(($FREE_KB/1024/1024)) GiB (>= 5 GiB)"
    else
      warn "disk free $(($FREE_KB/1024)) MiB (< 5 GiB recommended for all six services)"
    fi
  else
    warn "could not determine free disk space"
  fi
else
  warn "df unavailable; skipping disk check"
fi
if [ -r /proc/meminfo ]; then
  MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [ "$MEM_KB" -ge 4194304 ]; then
    ok "memory $((MEM_KB/1024/1024)) GiB (>= 4 GiB)"
  else
    warn "memory $((MEM_KB/1024)) MiB (< 4 GiB recommended for all six services)"
  fi
else
  warn "could not determine memory (non-Linux); ensure >= 4 GiB RAM"
fi

# --- 5. installer inputs ------------------------------------------------------
if [ -f "$COMPOSE_FILE" ]; then
  warn "compose file ${COMPOSE_FILE} already exists (install will reuse it; use --reset to recreate)"
else
  ok "compose file ${COMPOSE_FILE} absent (install will create it)"
fi
if [ -f .env ] || [ -f .env.substrate ]; then
  ok "env file present (.env or .env.substrate; install reuses stored secrets)"
else
  warn "no .env / .env.substrate yet (install will prompt for secrets)"
fi

# --- summary ------------------------------------------------------------------
[ "$QUIET" -eq 0 ] && printf -- '---\npreflight: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
if [ "$STRICT" -eq 1 ] && [ "$WARN" -gt 0 ]; then
  exit 1
fi
exit 0
