#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-ao-cloud}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
NODEOPS_SECRET_ID="${AO_CLOUD_NODEOPS_SECRET_ID:-ao-cloud/staging/nodeops}"
TEMPLATE_NAME="${AO_CLOUD_NODEOPS_TEMPLATE_NAME:-ao-worker-20260814}"
DOCKERFILE="${AO_CLOUD_NODEOPS_DOCKERFILE:-nodeops/Sandbox.Dockerfile}"

if [[ ! -f "$DOCKERFILE" ]]; then
    echo "NodeOps template Dockerfile not found: $DOCKERFILE" >&2
    exit 1
fi

secret="$(AWS_PROFILE="$AWS_PROFILE" aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$NODEOPS_SECRET_ID" \
    --query SecretString \
    --output text)"
base_url="$(jq -r '.base_url // empty' <<<"$secret")"
api_key="$(jq -r '.api_key // empty' <<<"$secret")"
unset secret

if [[ -z "$base_url" || -z "$api_key" ]]; then
    echo "NodeOps secret is missing base_url or api_key." >&2
    exit 1
fi

payload="$(jq -n \
    --arg name "$TEMPLATE_NAME" \
    --rawfile dockerfile "$DOCKERFILE" \
    '{name: $name, dockerfile: $dockerfile}')"
response="$(curl --fail --silent --show-error \
    -X POST "$base_url/v1/templates" \
    -H "X-Api-Key: $api_key" \
    -H "Content-Type: application/json" \
    --data-binary "$payload")"
template_id="$(jq -r '.data.id // empty' <<<"$response")"
if [[ -z "$template_id" ]]; then
    echo "NodeOps did not return a template id." >&2
    jq . <<<"$response" >&2
    exit 1
fi

echo "Submitted NodeOps template $TEMPLATE_NAME ($template_id)."
while true; do
    response="$(curl --fail --silent --show-error \
        "$base_url/v1/templates/$template_id" \
        -H "X-Api-Key: $api_key")"
    status="$(jq -r '.data.status // empty' <<<"$response")"
    case "$status" in
        ready)
            echo "NodeOps template $TEMPLATE_NAME is ready."
            break
            ;;
        failed)
            echo "NodeOps template $TEMPLATE_NAME failed to build." >&2
            curl --fail --silent --show-error \
                "$base_url/v1/templates/$template_id/logs" \
                -H "X-Api-Key: $api_key" >&2 || true
            exit 1
            ;;
        pending|building)
            printf 'Template status: %s\n' "$status"
            sleep 5
            ;;
        *)
            echo "Unexpected NodeOps template status: $status" >&2
            exit 1
            ;;
    esac
done
