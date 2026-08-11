#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"
CLUSTER="${AO_CLOUD_ECS_CLUSTER:-ao-cloud-staging}"
SERVICE="${AO_CLOUD_ECS_SERVICE:-ao-cloud-staging-api}"
REPOSITORY="${AO_CLOUD_ECR_REPOSITORY:-ao-cloud-control-plane}"
API_FAMILY="${AO_CLOUD_API_TASK_FAMILY:-ao-cloud-staging-api}"
MIGRATION_FAMILY="${AO_CLOUD_MIGRATION_TASK_FAMILY:-ao-cloud-staging-migrate}"
ROLLBACK_ALARM="${AO_CLOUD_ROLLBACK_ALARM:-ao-cloud-staging-target-5xx}"
RUNTIME_DATABASE_USER="${AO_CLOUD_RUNTIME_DATABASE_USER:-ao_cloud_app}"
RELEASE="${1:-$(git rev-parse --short=12 HEAD)}"
IMAGE_TAG="${RELEASE//+/-}-linux-amd64"

AWS_OPTIONS=(--region "$REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
	AWS_OPTIONS+=(--profile "$AWS_PROFILE")
fi

aws_cli() {
	aws "${AWS_OPTIONS[@]}" "$@"
}

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Refusing to deploy a dirty working tree." >&2
	exit 1
fi
if [[ ! "$RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$ ]]; then
	echo "Release must be a Git SHA or release tag." >&2
	exit 1
fi

repository_uri="$(
	aws_cli ecr describe-repositories \
		--repository-names "$REPOSITORY" \
		--query 'repositories[0].repositoryUri' \
		--output text
)"
registry="${repository_uri%%/*}"

aws_cli ecr get-login-password |
	docker login --username AWS --password-stdin "$registry" >/dev/null
if ! aws_cli ecr describe-images \
	--repository-name "$REPOSITORY" \
	--image-ids "imageTag=${IMAGE_TAG}" >/dev/null 2>&1; then
	docker build \
		--platform linux/amd64 \
		--provenance=false \
		--tag "${repository_uri}:${IMAGE_TAG}" \
		.
	docker push "${repository_uri}:${IMAGE_TAG}"
fi

image_digest="$(
	aws_cli ecr describe-images \
		--repository-name "$REPOSITORY" \
		--image-ids "imageTag=${IMAGE_TAG}" \
		--query 'imageDetails[0].imageDigest' \
		--output text
)"
image="${repository_uri}@${image_digest}"

aws_cli ecr start-image-scan \
	--repository-name "$REPOSITORY" \
	--image-id "imageDigest=${image_digest}" >/dev/null 2>&1 || true
scan_status=""
for _ in $(seq 1 60); do
	scan_status="$(
		aws_cli ecr describe-image-scan-findings \
			--repository-name "$REPOSITORY" \
			--image-id "imageDigest=${image_digest}" \
			--query 'imageScanStatus.status' \
			--output text 2>/dev/null || true
	)"
	case "$scan_status" in
	COMPLETE) break ;;
	FAILED) echo "ECR image scan failed." >&2; exit 1 ;;
	esac
	sleep 2
done
if [[ "$scan_status" != "COMPLETE" ]]; then
	echo "ECR image scan did not complete." >&2
	exit 1
fi

severity_counts="$(
	aws_cli ecr describe-image-scan-findings \
		--repository-name "$REPOSITORY" \
		--image-id "imageDigest=${image_digest}" \
		--query 'imageScanFindings.findingSeverityCounts' \
		--output json
)"
if ! SEVERITY_COUNTS="$severity_counts" python3 - <<'PY'
import json
import os
import sys

counts = json.loads(os.environ["SEVERITY_COUNTS"] or "{}")
sys.exit(1 if counts.get("CRITICAL", 0) or counts.get("HIGH", 0) else 0)
PY
then
	echo "ECR scan found critical or high vulnerabilities." >&2
	exit 1
fi

register_task_definition() {
	local family="$1"
	local container_name="$2"
	local source payload
	source="$(aws_cli ecs describe-task-definition --task-definition "$family" --include TAGS)"
	payload="$(
		SOURCE="$source" \
			IMAGE="$image" \
			RELEASE="$RELEASE" \
			CONTAINER_NAME="$container_name" \
			RUNTIME_DATABASE_USER="$RUNTIME_DATABASE_USER" \
			python3 - <<'PY'
import json
import os

source = json.loads(os.environ["SOURCE"])
task = source["taskDefinition"]
allowed = {
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "containerDefinitions",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
    "ephemeralStorage",
    "runtimePlatform",
}
payload = {key: value for key, value in task.items() if key in allowed}
for container in payload["containerDefinitions"]:
    if container["name"] != os.environ["CONTAINER_NAME"]:
        continue
    container["image"] = os.environ["IMAGE"]
    environment = container.setdefault("environment", [])
    for variable in environment:
        if variable["name"] == "AO_CLOUD_RELEASE":
            variable["value"] = os.environ["RELEASE"]
    if container["name"] == "migration":
        environment[:] = [
            variable
            for variable in environment
            if variable["name"] != "AO_CLOUD_RUNTIME_DATABASE_USER"
        ]
        environment.append({
            "name": "AO_CLOUD_RUNTIME_DATABASE_USER",
            "value": os.environ["RUNTIME_DATABASE_USER"],
        })
payload["tags"] = [
    tag for tag in source.get("tags", []) if tag["key"] != "Release"
] + [{"key": "Release", "value": os.environ["RELEASE"]}]
print(json.dumps(payload))
PY
	)"
	aws_cli ecs register-task-definition \
		--cli-input-json "$payload" \
		--query 'taskDefinition.taskDefinitionArn' \
		--output text
}

api_task="$(register_task_definition "$API_FAMILY" control-plane)"
migration_task="$(register_task_definition "$MIGRATION_FAMILY" migration)"
network_configuration="$(
	aws_cli ecs describe-services \
		--cluster "$CLUSTER" \
		--services "$SERVICE" \
		--query 'services[0].networkConfiguration' \
		--output json
)"
migration_result="$(
	aws_cli ecs run-task \
		--cluster "$CLUSTER" \
		--launch-type FARGATE \
		--platform-version LATEST \
		--task-definition "$migration_task" \
		--network-configuration "$network_configuration" \
		--started-by "deploy-${RELEASE:0:28}" \
		--tags \
			key=Project,value=ao-cloud \
			key=Environment,value=staging \
			"key=Release,value=${RELEASE}"
)"
migration_arn="$(
	MIGRATION_RESULT="$migration_result" python3 - <<'PY'
import json
import os

result = json.loads(os.environ["MIGRATION_RESULT"])
if result.get("failures") or not result.get("tasks"):
    raise SystemExit("ECS refused to start the migration task")
print(result["tasks"][0]["taskArn"])
PY
)"
aws_cli ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$migration_arn"
migration_exit="$(
	aws_cli ecs describe-tasks \
		--cluster "$CLUSTER" \
		--tasks "$migration_arn" \
		--query 'tasks[0].containers[0].exitCode' \
		--output text
)"
if [[ "$migration_exit" != "0" ]]; then
	aws_cli ecs describe-tasks \
		--cluster "$CLUSTER" \
		--tasks "$migration_arn" \
		--query 'tasks[0].{reason:stoppedReason,containerReason:containers[0].reason}' \
		--output json >&2
	exit 1
fi

aws_cli ecs update-service \
	--cluster "$CLUSTER" \
	--service "$SERVICE" \
	--task-definition "$api_task" \
	--desired-count 2 \
	--health-check-grace-period-seconds 60 \
	--deployment-configuration \
	"{\"maximumPercent\":200,\"minimumHealthyPercent\":100,\"deploymentCircuitBreaker\":{\"enable\":true,\"rollback\":true},\"alarms\":{\"alarmNames\":[\"${ROLLBACK_ALARM}\"],\"enable\":true,\"rollback\":true}}" \
	>/dev/null
aws_cli ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

deployed_task="$(
	aws_cli ecs describe-services \
		--cluster "$CLUSTER" \
		--services "$SERVICE" \
		--query 'services[0].taskDefinition' \
		--output text
)"
if [[ "$deployed_task" != "$api_task" ]]; then
	echo "ECS rolled back instead of deploying ${api_task}." >&2
	exit 1
fi

target_group="$(
	aws_cli ecs describe-services \
		--cluster "$CLUSTER" \
		--services "$SERVICE" \
		--query 'services[0].loadBalancers[0].targetGroupArn' \
		--output text
)"
unhealthy_targets="$(
	aws_cli elbv2 describe-target-health \
		--target-group-arn "$target_group" \
		--query "length(TargetHealthDescriptions[?TargetHealth.State!=\`healthy\`])" \
		--output text
)"
if [[ "$unhealthy_targets" != "0" ]]; then
	echo "Deployment completed with unhealthy ALB targets." >&2
	exit 1
fi

printf 'Deployed release %s\nImage digest: %s\nTask definition: %s\n' \
	"$RELEASE" \
	"$image_digest" \
	"$api_task"
