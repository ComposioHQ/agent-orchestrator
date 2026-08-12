#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repository_root/scripts/lib/docker-local.sh"
if ! ao_docker_available; then
	printf 'SKIP: Docker Engine with Compose is unavailable; local lifecycle smoke test not run.\n'
	exit 0
fi

project_name="ao-cloud-smoke-${PPID}-$$"
state_root="${AO_DATA_DIR:-$HOME/.ao}"
mkdir -p "$state_root"
umask 077
state_directory="$(mktemp -d "${state_root}/cloud-smoke.XXXXXX")"
state_file="${state_directory}/state.json"

free_port() {
	python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

export AO_CLOUD_PORT="${AO_CLOUD_SMOKE_PORT:-$(free_port)}"
export AO_CLOUD_POSTGRES_PORT="${AO_CLOUD_SMOKE_POSTGRES_PORT:-$(free_port)}"
export AO_CLOUD_LOCAL_POSTGRES_DATA_DIR="$state_directory/postgres"
export AO_CLOUD_PROVIDER_SECRET_KEY
AO_CLOUD_PROVIDER_SECRET_KEY="$(openssl rand -base64 32)"
export AO_CLOUD_WORKER_SIGNING_KEY
AO_CLOUD_WORKER_SIGNING_KEY="$(openssl rand -hex 32)"
export AO_CLOUD_DOCKER_GID
AO_CLOUD_DOCKER_GID="$(ao_docker_socket_gid)"
export AO_CLOUD_DOCKER_WORKER_IMAGE="${project_name}-worker:smoke"
export COMPOSE_PROJECT_NAME="$project_name"

compose() {
	docker compose --project-directory "$repository_root" "$@"
}

cleanup() {
	ao_docker_remove_workers "$project_name" >/dev/null 2>&1 || true
	compose down --volumes --remove-orphans >/dev/null 2>&1 || true
	ao_docker_remove_workspaces "$project_name" >/dev/null 2>&1 || true
	rm -rf "$state_directory"
}
trap cleanup EXIT

wait_for_ready() {
	local attempts=30
	while ((attempts > 0)); do
		if curl \
			--fail \
			--silent \
			--show-error \
			--max-time 2 \
			"http://127.0.0.1:${AO_CLOUD_PORT}/readyz" >/dev/null 2>&1; then
			return 0
		fi
		attempts=$((attempts - 1))
		sleep 1
	done
	echo "Local AO Cloud did not become ready on 127.0.0.1:${AO_CLOUD_PORT}." >&2
	compose logs >&2
	return 1
}

assert_loopback_port() {
	local service="$1"
	local container_port="$2"
	local expected_port="$3"
	local binding
	binding="$(compose port "$service" "$container_port")"
	if [[ "$binding" != "127.0.0.1:${expected_port}" ]]; then
		echo "${service} port is not loopback-only: ${binding}" >&2
		return 1
	fi
}

exercise_api() {
	local mode="$1"
	python3 - "$mode" "$AO_CLOUD_PORT" "$state_file" <<'PY'
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

mode, port, state_path = sys.argv[1:]
base_url = f"http://127.0.0.1:{port}"
state_file = pathlib.Path(state_path)


def request(method, path, *, body=None, token=None, idempotency_key=None, expected=200):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    operation = urllib.request.Request(
        base_url + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(operation, timeout=10)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(
            f"{method} {path} returned {error.code}, expected {expected}: {detail}"
        ) from error
    with response:
        if response.status != expected:
            raise RuntimeError(
                f"{method} {path} returned {response.status}, expected {expected}"
            )
        return json.load(response)


def wait_for_running(org_id, session_id, token):
    deadline = time.monotonic() + 90
    last_state = None
    while time.monotonic() < deadline:
        session = request(
            "GET",
            f"/api/cloud/v1/orgs/{org_id}/sessions/{session_id}",
            token=token,
        )["session"]
        last_state = session["runtimeState"]
        if last_state == "running":
            return session
        if last_state == "failed":
            raise RuntimeError(f"worker provisioning failed: {session!r}")
        time.sleep(1)
    raise RuntimeError(f"worker did not become running; last state was {last_state!r}")


if mode == "create":
    suffix = str(time.time_ns())
    auth = request(
        "POST",
        "/api/cloud/v1/auth/local/register",
        body={
            "email": f"cloud-smoke-{suffix}@example.com",
            "displayName": "Cloud Smoke",
            "password": "local-smoke-password",
            "orgSlug": f"cloud-smoke-{suffix}",
            "orgName": "Cloud Smoke",
        },
        expected=201,
    )
    token = auth["token"]
    org_id = auth["organizations"][0]["id"]
    project = request(
        "POST",
        f"/api/cloud/v1/orgs/{org_id}/projects",
        body={
            "displayName": "Persistence Test",
            "repositoryUrl": "https://github.com/Untrivial-ai/agent-orchestrator",
            "defaultBranch": "main",
            "config": {},
        },
        token=token,
        idempotency_key=f"project-{suffix}",
        expected=201,
    )["project"]
    session = request(
        "POST",
        f"/api/cloud/v1/orgs/{org_id}/sessions",
        body={
            "projectId": project["id"],
            "kind": "worker",
            "harness": "claude-code",
            "displayName": "Persistence Test",
            "prompt": "",
        },
        token=token,
        idempotency_key=f"session-{suffix}",
        expected=201,
    )["session"]
    wait_for_running(org_id, session["id"], token)
    workspace_file = request(
        "PUT",
        f"/api/cloud/v1/orgs/{org_id}/sessions/{session['id']}/workspace/file",
        body={"path": ".ao-cloud-smoke-api", "content": "durable-worker-transport\n"},
        token=token,
    )
    if workspace_file.get("content") != "durable-worker-transport\n":
        raise RuntimeError(f"workspace write returned unexpected content: {workspace_file!r}")
    read_back = request(
        "GET",
        f"/api/cloud/v1/orgs/{org_id}/sessions/{session['id']}/workspace/file?path=.ao-cloud-smoke-api",
        token=token,
    )
    if read_back != workspace_file:
        raise RuntimeError(
            f"workspace read did not match the durable write: {read_back!r}"
        )
    listing = request(
        "GET",
        f"/api/cloud/v1/orgs/{org_id}/sessions/{session['id']}/workspace/files?limit=100",
        token=token,
    )
    if ".ao-cloud-smoke-api" not in {item.get("path") for item in listing["items"]}:
        raise RuntimeError(f"workspace listing omitted the written file: {listing!r}")
    request(
        "POST",
        f"/api/cloud/v1/orgs/{org_id}/sessions/{session['id']}/messages",
        body={"text": "Message persisted before restart"},
        token=token,
        idempotency_key=f"message-{suffix}",
        expected=202,
    )
    state_file.write_text(
        json.dumps(
            {
                "token": token,
                "orgId": org_id,
                "sessionId": session["id"],
            }
        )
    )
elif mode == "verify":
    state = json.loads(state_file.read_text())
    token = state["token"]
    org_id = state["orgId"]
    session_id = state["sessionId"]
    wait_for_running(org_id, session_id, token)
    events = request(
        "GET",
        f"/api/cloud/v1/orgs/{org_id}/sessions/{session_id}/chat-events?after=0&limit=100",
        token=token,
    )["events"]
    messages = [
        event.get("payload", {}).get("text")
        for event in events
        if event.get("type") == "chat.user_message"
    ]
    expected = {"Message persisted before restart"}
    if not expected.issubset(messages):
        raise RuntimeError(f"durable messages missing after restart: {messages!r}")
else:
    raise RuntimeError(f"unknown smoke-test mode: {mode}")
PY
}

session_id() {
	python3 - "$state_file" <<'PY'
import json
import pathlib
import sys

print(json.loads(pathlib.Path(sys.argv[1]).read_text())["sessionId"])
PY
}

wait_for_worker() {
	local session="$1"
	local previous="${2:-}"
	local attempts=90
	local container_id
	while ((attempts > 0)); do
		container_id="$(
			docker ps --quiet \
				--filter "label=ao.managed=true" \
				--filter "label=ao.provider=docker" \
				--filter "label=ao.docker.namespace=${project_name}" \
				--filter "label=ao.session_id=${session}"
		)"
		if [[ -n "$container_id" && "$container_id" != "$previous" ]]; then
			printf '%s\n' "$container_id"
			return 0
		fi
		attempts=$((attempts - 1))
		sleep 1
	done
	echo "Worker container for session ${session} did not appear." >&2
	compose logs control-plane >&2
	return 1
}

assert_workspace_marker() {
	local container_id="$1"
	local marker
	marker="$(docker exec "$container_id" bash -c 'cat /workspace/repository/.ao-cloud-smoke')"
	if [[ "$marker" != "persistent-workspace" ]]; then
		echo "Worker workspace marker did not survive container replacement." >&2
		return 1
	fi
}

compose --profile worker-image build worker-image
compose up --build -d
wait_for_ready
assert_loopback_port control-plane 8080 "$AO_CLOUD_PORT"
assert_loopback_port postgres 5432 "$AO_CLOUD_POSTGRES_PORT"

role_state="$(
	compose exec -T \
		-e PGPASSWORD=ao_cloud_local_owner \
		postgres \
		psql \
		--username ao_cloud_owner \
		--dbname ao_cloud \
		--tuples-only \
		--no-align \
		--command \
		"SELECT rolname || ':' || rolsuper || ':' || rolbypassrls || ':' || rolcanlogin
		 FROM pg_roles
		 WHERE rolname IN ('ao_cloud_app', 'ao_cloud_bootstrap', 'ao_cloud_owner')
		 ORDER BY rolname"
)"
expected_role_state="$(
	cat <<'EOF'
ao_cloud_app:false:false:true
ao_cloud_bootstrap:true:true:false
ao_cloud_owner:false:false:true
EOF
)"
if [[ "$role_state" != "$expected_role_state" ]]; then
	echo "Unexpected local PostgreSQL role state:" >&2
	echo "$role_state" >&2
	exit 1
fi

exercise_api create
session="$(session_id)"
first_worker="$(wait_for_worker "$session")"
docker exec "$first_worker" bash -c \
	'printf "%s\n" persistent-workspace > /workspace/repository/.ao-cloud-smoke'
docker rm --force "$first_worker" >/dev/null
replacement_worker="$(wait_for_worker "$session" "$first_worker")"
assert_workspace_marker "$replacement_worker"
exercise_api verify

compose restart control-plane >/dev/null
wait_for_ready
exercise_api verify

ao_docker_remove_workers "$project_name"
compose down --remove-orphans >/dev/null
compose up -d
wait_for_ready
restarted_worker="$(wait_for_worker "$session")"
assert_workspace_marker "$restarted_worker"
exercise_api verify

ao_docker_remove_workers "$project_name"
compose down --volumes --remove-orphans >/dev/null
ao_docker_remove_workspaces "$project_name"
if docker volume inspect "${project_name}_ao-cloud-postgres" >/dev/null 2>&1; then
	echo "cloud:local:reset semantics left the PostgreSQL volume behind." >&2
	exit 1
fi

trap - EXIT
rm -rf "$state_directory"
printf 'AO Cloud local lifecycle smoke test passed.\n'
