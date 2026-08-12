#!/usr/bin/env bash

ao_docker_available() {
	command -v docker >/dev/null 2>&1 &&
		docker compose version >/dev/null 2>&1 &&
		docker info >/dev/null 2>&1
}

ao_docker_socket_gid() {
	local socket="${1:-/var/run/docker.sock}"
	if [[ "$(uname -s)" == "Darwin" ]]; then
		# Docker Desktop proxies the host socket into its Linux VM as root:root,
		# regardless of the macOS socket's group.
		printf '0\n'
	else
		stat -c '%g' "$socket"
	fi
}

ao_docker_remove_workers() {
	local namespace="$1"
	local container_id
	while IFS= read -r container_id; do
		[[ -n "$container_id" ]] || continue
		docker rm --force "$container_id" >/dev/null
	done < <(
		docker ps --all --quiet \
			--filter "label=ao.managed=true" \
			--filter "label=ao.provider=docker" \
			--filter "label=ao.docker.namespace=${namespace}"
	)
}

ao_docker_remove_workspaces() {
	local namespace="$1"
	local volume
	while IFS= read -r volume; do
		[[ -n "$volume" ]] || continue
		docker volume rm "$volume" >/dev/null
	done < <(
		docker volume ls --quiet \
			--filter "label=ao.managed=true" \
			--filter "label=ao.provider=docker" \
			--filter "label=ao.docker.namespace=${namespace}"
	)
}
