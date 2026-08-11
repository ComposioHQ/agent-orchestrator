#!/usr/bin/env bash
set -euo pipefail

staging_url="${AO_CLOUD_STAGING_URL:-}"
if [[ "$staging_url" != https://* ]]; then
	echo "AO_CLOUD_STAGING_URL must be the hosted staging HTTPS origin." >&2
	exit 1
fi
staging_url="${staging_url%/}"

if [[ -z "${VITE_WORKOS_CLIENT_ID:-}" ]]; then
	echo "VITE_WORKOS_CLIENT_ID is required for the desktop WorkOS flow." >&2
	exit 1
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
curl \
	--fail \
	--silent \
	--show-error \
	--max-time 10 \
	--proto '=https' \
	--tlsv1.2 \
	--output "$response_file" \
	"${staging_url}/readyz"

python3 - "$response_file" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
if payload.get("status") != "ready":
    raise SystemExit("The staging control plane is not ready.")
if payload.get("environment") != "staging":
    raise SystemExit(
        f"Refusing to launch against {payload.get('environment')!r}; expected staging."
    )
PY

public_repository="${AO_PUBLIC_REPOSITORY:-$(git rev-parse --show-superproject-working-tree)}"
if [[ -z "$public_repository" || ! -f "$public_repository/frontend/package.json" ]]; then
	echo "Set AO_PUBLIC_REPOSITORY to an Agent Orchestrator checkout containing frontend/." >&2
	exit 1
fi

export AO_CLOUD_API_BASE_URL="$staging_url"
export VITE_AO_CLOUD_API_BASE_URL="$staging_url"
export AO_DATA_DIR="${AO_CLOUD_STAGING_DATA_DIR:-$HOME/.ao/staging-desktop}"

printf 'Launching AO desktop against staging API %s\n' "$staging_url"
printf 'Isolated desktop state: %s\n' "$AO_DATA_DIR"
exec npm --prefix "$public_repository/frontend" run dev
