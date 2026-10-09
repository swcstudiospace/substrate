#!/usr/bin/env bash
# D-12/D-18 substrate-desktop: a dedicated linuxserver/webtop:ubuntu-xfce container that
# substrate-mcp's desktop_run drives with `docker exec -e DISPLAY=:1 substrate-desktop xdotool|xwd`.
# Nothing is pulled: the image must already be local (`--pull never`), `up` runs the disk gate
# (df --output=avail -B1 / >= 10737418240) first, then refuses a non-local docker endpoint
# (DOCKER_HOST, saved context or effective endpoint) before the first docker call.
#
#   sudo infra/desktop/substrate-desktop.sh up      # idempotent: create, start if stopped, wait for 1280x800
#   sudo infra/desktop/substrate-desktop.sh status  # key=value lines
#
# The container carries the role label org.swcstudio.substrate.role=desktop, is unprivileged, has
# no host mounts and no docker socket, and publishes its web view on 127.0.0.1:6081 only, behind
# basic auth from /etc/substrate/substrate-desktop.env (0600 root, generated once, never printed).
# Run as root by the operator, not by substrate-mcp (ProtectSystem=full keeps /etc read-only to the
# service). No systemd unit: `--restart unless-stopped` covers reboots. This script only creates
# and starts this one container; it never removes, stops or pulls anything and names no other
# container. The rollback routes live in docs/runbooks/desktop.md.
set -euo pipefail

NAME=substrate-desktop
IMAGE=linuxserver/webtop:ubuntu-xfce
VOLUME=substrate-desktop-config
ENV_FILE=${SUBSTRATE_DESKTOP_ENV_FILE:-/etc/substrate/substrate-desktop.env}  # test seam; operators leave it unset
LABEL=org.swcstudio.substrate.role=desktop
PUBLISH=127.0.0.1:6081:3000
MIN_FREE_BYTES=10737418240
GEOMETRY_WAIT_S=60

LABEL_KEY=${LABEL%%=*}
LABEL_VALUE=${LABEL#*=}

die() {
	echo "substrate-desktop: $*" >&2
	exit 1
}

require_root() {
	[ "${EUID}" -eq 0 ] || die "must run as root"
}

exists() {
	docker container inspect "$NAME" >/dev/null 2>&1
}

inspect() {
	docker container inspect --format "$1" "$NAME"
}

geometry() {
	docker exec -e DISPLAY=:1 "$NAME" xdotool getdisplaygeometry 2>&1
}

# The basic-auth credentials: generated once under umask 077, renamed into place, never echoed.
ensure_env_file() {
	[ -e "$ENV_FILE" ] && return 0
	local tmp password
	umask 077
	tmp=$(mktemp "$(dirname "$ENV_FILE")/.substrate-desktop.env.XXXXXX")
	password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)
	if [ "${#password}" -ne 32 ]; then
		rm -f "$tmp"
		die "could not generate a 32-character password"
	fi
	printf 'CUSTOM_USER=substrate\nPASSWORD=%s\n' "$password" >"$tmp"
	unset password
	chmod 600 "$tmp"
	mv "$tmp" "$ENV_FILE"
}

# Locality gate: a DOCKER_HOST or saved context selecting a remote engine would
# create or start substrate-desktop on the wrong host while the disk gate checks
# this machine. Refuse before the first docker call, mirroring the rehearsal
# harness's refuseDockerEnv/refuseDockerEndpoint rules. An inspect failure
# proves nothing and proceeds: the client is broken, so every later docker call
# fails with its own truthful error and nothing remote can happen.
require_local_docker() {
	local host="${DOCKER_HOST:-}" context="${DOCKER_CONTEXT:-}" endpoint
	case "$host" in
		""|unix://*) ;;
		*) die "refusing non-local DOCKER_HOST $host" ;;
	esac
	case "$context" in
		""|default|desktop-linux) ;;
		*) die "refusing non-local docker context $context" ;;
	esac
	if endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null); then
		endpoint=${endpoint%%$'\n'*}
		case "$endpoint" in
			unix://*) ;;
			"") die "could not read the docker endpoint; refusing without locality proof" ;;
			*) die "refusing non-local docker endpoint $endpoint" ;;
		esac
	fi
}

cmd_up() {
	require_root
	local avail
	avail=$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')
	[ "$avail" -ge "$MIN_FREE_BYTES" ] || die "only $avail bytes free on /; need $MIN_FREE_BYTES"
	require_local_docker
	docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image not local; refusing to pull $IMAGE"
	ensure_env_file

	if exists; then
		local role
		role=$(inspect "{{index .Config.Labels \"$LABEL_KEY\"}}")
		[ "$role" = "$LABEL_VALUE" ] || die "a container named $NAME exists without $LABEL; refusing to touch it"
		if [ "$(inspect '{{.State.Running}}')" != "true" ]; then
			docker start "$NAME" >/dev/null
		fi
	else
		docker run -d --pull never --name "$NAME" \
			--restart unless-stopped --shm-size 1g \
			--label "$LABEL" \
			-p "$PUBLISH" \
			-v "$VOLUME:/config" \
			--env-file "$ENV_FILE" \
			-e TZ=Etc/UTC -e TITLE="Substrate desktop" -e START_DOCKER=false \
			-e SELKIES_MANUAL_WIDTH=1280 -e SELKIES_MANUAL_HEIGHT=800 \
			"$IMAGE" >/dev/null
	fi

	local deadline=$((SECONDS + GEOMETRY_WAIT_S)) last=""
	while :; do
		last=$(geometry || true)
		[ "$last" = "1280 800" ] && break
		[ "$SECONDS" -lt "$deadline" ] || die "display not 1280 800 after ${GEOMETRY_WAIT_S} s; last output: ${last:-<none>}"
		sleep 2
	done
	echo "up id=$(inspect '{{.Id}}') geometry=1280x800"
}

cmd_status() {
	require_root
	if ! exists; then
		printf '%s\n' exists=false running=false restart= ports= geometry=unknown image= label_role= \
			privileged= mounts= docker_socket_mounted=false id=
		return 0
	fi
	local running geo ports mounts sources socket=false
	running=$(inspect '{{.State.Running}}')
	geo=unknown
	if [ "$running" = "true" ]; then
		geo=$(geometry || true)
		[[ "$geo" =~ ^[0-9]+\ [0-9]+$ ]] && geo=${geo/ /x} || geo=unknown
	fi
# shellcheck disable=SC2016  # Go template, expanded by docker, not the shell
	ports=$(inspect '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}}{{"\n"}}{{end}}{{end}}' |
		sed 's#/tcp$##' | sed '/^$/d' | sort -u | paste -sd, -)
	mounts=$(inspect '{{range .Mounts}}{{.Type}}:{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}->{{.Destination}}{{"\n"}}{{end}}' |
		sed '/^$/d' | paste -sd, -)
	sources=$(inspect '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}')
	if grep -qxE '/(var/)?run/docker\.sock' <<<"$sources"; then socket=true; fi
	echo "exists=true"
	echo "running=$running"
	echo "restart=$(inspect '{{.HostConfig.RestartPolicy.Name}}')"
	echo "ports=$ports"
	echo "geometry=$geo"
	echo "image=$(inspect '{{.Config.Image}}')"
	echo "label_role=$(inspect "{{index .Config.Labels \"$LABEL_KEY\"}}")"
	echo "privileged=$(inspect '{{.HostConfig.Privileged}}')"
	echo "mounts=$mounts"
	echo "docker_socket_mounted=$socket"
	echo "id=$(inspect '{{.Id}}')"
}

case "${1:-}" in
up) cmd_up ;;
status) cmd_status ;;
*)
	echo "usage: $0 up|status" >&2
	exit 2
	;;
esac
