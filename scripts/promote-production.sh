#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"
STAGING_CLUSTER="${AO_CLOUD_STAGING_CLUSTER:-ao-cloud-staging}"
STAGING_SERVICE="${AO_CLOUD_STAGING_SERVICE:-ao-cloud-staging-api}"
STAGING_ROLLBACK_ALARM="${AO_CLOUD_STAGING_ROLLBACK_ALARM:-ao-cloud-staging-target-5xx}"
PRODUCTION_CLUSTER="${AO_CLOUD_PRODUCTION_CLUSTER:-ao-cloud-production}"
PRODUCTION_SERVICE="${AO_CLOUD_PRODUCTION_SERVICE:-ao-cloud-production-api}"
PRODUCTION_API_FAMILY="${AO_CLOUD_PRODUCTION_API_FAMILY:-ao-cloud-production-api}"
PRODUCTION_MIGRATION_FAMILY="${AO_CLOUD_PRODUCTION_MIGRATION_FAMILY:-ao-cloud-production-migrate}"
PRODUCTION_ALB="${AO_CLOUD_PRODUCTION_ALB:-ao-cloud-production-public}"
PRODUCTION_TARGET_GROUP="${AO_CLOUD_PRODUCTION_TARGET_GROUP:-ao-cloud-production-public-cp}"
PRODUCTION_TASK_SECURITY_GROUP="${AO_CLOUD_PRODUCTION_TASK_SECURITY_GROUP:-ao-cloud-production-task-sg}"
ROLLBACK_ALARM="${AO_CLOUD_PRODUCTION_ROLLBACK_ALARM:-ao-cloud-production-target-5xx}"
RUNTIME_DATABASE_USER="${AO_CLOUD_RUNTIME_DATABASE_USER:-ao_cloud_app}"

AWS_OPTIONS=(--region "$REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
	AWS_OPTIONS+=(--profile "$AWS_PROFILE")
fi

aws_cli() {
	aws "${AWS_OPTIONS[@]}" "$@"
}

if [[ "${AO_CLOUD_APPROVE_PRODUCTION:-}" != "1" ]]; then
	echo "Set AO_CLOUD_APPROVE_PRODUCTION=1 to approve production promotion." >&2
	exit 1
fi

staging_task="$(
	aws_cli ecs describe-services \
		--cluster "$STAGING_CLUSTER" \
		--services "$STAGING_SERVICE" \
		--query 'services[0].taskDefinition' \
		--output text
)"
staging_source="$(
	aws_cli ecs describe-task-definition \
		--task-definition "$staging_task" \
		--include TAGS
)"
staging_release="$(
	SOURCE="$staging_source" python3 - <<'PY'
import json
import os

source = json.loads(os.environ["SOURCE"])
container = next(
    item
    for item in source["taskDefinition"]["containerDefinitions"]
    if item["name"] == "control-plane"
)
environment = {item["name"]: item["value"] for item in container["environment"]}
print(environment["AO_CLOUD_RELEASE"])
PY
)"
release="${1:-$staging_release}"
if [[ "$release" != "$staging_release" ]]; then
	echo "Release ${release} is not the healthy staging release ${staging_release}." >&2
	exit 1
fi
./scripts/verify-ecs-service.py \
	--region "$REGION" \
	--cluster "$STAGING_CLUSTER" \
	--service "$STAGING_SERVICE" \
	--alarm "$STAGING_ROLLBACK_ALARM" \
	--expected-task-definition "$staging_task" >/dev/null
./scripts/verify-ecs-service.py \
	--region "$REGION" \
	--cluster "$PRODUCTION_CLUSTER" \
	--service "$PRODUCTION_SERVICE" \
	--alarm "$ROLLBACK_ALARM" >/dev/null

image="$(
	SOURCE="$staging_source" python3 - <<'PY'
import json
import os

source = json.loads(os.environ["SOURCE"])
container = next(
    item
    for item in source["taskDefinition"]["containerDefinitions"]
    if item["name"] == "control-plane"
)
print(container["image"])
PY
)"
if [[ "$image" != *@sha256:* ]]; then
	echo "Staging is not pinned to an immutable image digest." >&2
	exit 1
fi
repository_uri="${image%@sha256:*}"
repository="${repository_uri##*/}"
image_digest="sha256:${image##*@sha256:}"

scan="$(
	aws_cli ecr describe-image-scan-findings \
		--repository-name "$repository" \
		--image-id "imageDigest=${image_digest}"
)"
if ! SCAN="$scan" python3 - <<'PY'
import json
import os
import sys

scan = json.loads(os.environ["SCAN"])
if scan["imageScanStatus"]["status"] != "COMPLETE":
    raise SystemExit(1)
counts = scan["imageScanFindings"].get("findingSeverityCounts", {})
sys.exit(1 if counts.get("CRITICAL", 0) or counts.get("HIGH", 0) else 0)
PY
then
	echo "The staging image does not have a clean completed ECR scan." >&2
	exit 1
fi

aws_cli iam get-role --role-name ao-cloud-production-execution-role >/dev/null
aws_cli iam get-role --role-name ao-cloud-production-task-role >/dev/null
aws_cli secretsmanager describe-secret \
	--secret-id ao-cloud/production/database-url >/dev/null
aws_cli secretsmanager describe-secret \
	--secret-id ao-cloud/production/migration-database-url >/dev/null
aws_cli secretsmanager describe-secret \
	--secret-id ao-cloud/production/workos >/dev/null

register_api_task() {
	local source payload
	source="$(
		aws_cli ecs describe-task-definition \
			--task-definition "$PRODUCTION_API_FAMILY" \
			--include TAGS
	)"
	payload="$(
		printf '%s' "$source" |
			./scripts/render-task-definition.py \
				--family "$PRODUCTION_API_FAMILY" \
				--container control-plane \
				--image "$image" \
				--release "$release" \
				--environment production \
				--log-group /ao-cloud/production/control-plane \
				--region "$REGION"
	)"
	aws_cli ecs register-task-definition \
		--cli-input-json "$payload" \
		--query 'taskDefinition.taskDefinitionArn' \
		--output text
}

register_migration_task() {
	local source payload
	source="$(
		aws_cli ecs describe-task-definition \
			--task-definition "$PRODUCTION_MIGRATION_FAMILY" \
			--include TAGS
	)"
	payload="$(
		printf '%s' "$source" |
			./scripts/render-task-definition.py \
				--family "$PRODUCTION_MIGRATION_FAMILY" \
				--container migration \
				--image "$image" \
				--release "$release" \
				--environment production \
				--log-group /ao-cloud/production/control-plane \
				--region "$REGION" \
				--runtime-database-user "$RUNTIME_DATABASE_USER"
	)"
	aws_cli ecs register-task-definition \
		--cli-input-json "$payload" \
		--query 'taskDefinition.taskDefinitionArn' \
		--output text
}

api_task="$(register_api_task)"
migration_task="$(register_migration_task)"
load_balancer="$(
	aws_cli elbv2 describe-load-balancers \
		--names "$PRODUCTION_ALB" \
		--query 'LoadBalancers[0]' \
		--output json
)"
subnets="$(
	LOAD_BALANCER="$load_balancer" python3 - <<'PY'
import json
import os

load_balancer = json.loads(os.environ["LOAD_BALANCER"])
print(",".join(zone["SubnetId"] for zone in load_balancer["AvailabilityZones"]))
PY
)"
vpc_id="$(
	LOAD_BALANCER="$load_balancer" python3 - <<'PY'
import json
import os

print(json.loads(os.environ["LOAD_BALANCER"])["VpcId"])
PY
)"
task_security_group="$(
	aws_cli ec2 describe-security-groups \
		--filters \
			"Name=vpc-id,Values=${vpc_id}" \
			"Name=group-name,Values=${PRODUCTION_TASK_SECURITY_GROUP}" \
		--query 'SecurityGroups[0].GroupId' \
		--output text
)"
network_configuration="awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${task_security_group}],assignPublicIp=ENABLED}"

migration_result="$(
	aws_cli ecs run-task \
		--cluster "$PRODUCTION_CLUSTER" \
		--launch-type FARGATE \
		--platform-version LATEST \
		--task-definition "$migration_task" \
		--network-configuration "$network_configuration" \
		--started-by "promote-${release:0:27}" \
		--tags \
			key=Project,value=ao-cloud \
			key=Environment,value=production \
			"key=Release,value=${release}"
)"
migration_arn="$(
	MIGRATION_RESULT="$migration_result" python3 - <<'PY'
import json
import os

result = json.loads(os.environ["MIGRATION_RESULT"])
if result.get("failures") or not result.get("tasks"):
    raise SystemExit("ECS refused to start the production migration task")
print(result["tasks"][0]["taskArn"])
PY
)"
cleanup_migration() {
	if [[ -n "${migration_arn:-}" && "${migration_complete:-false}" != "true" ]]; then
		aws_cli ecs stop-task \
			--cluster "$PRODUCTION_CLUSTER" \
			--task "$migration_arn" \
			--reason "AO Cloud promotion interrupted before migration completion" \
			>/dev/null 2>&1 || true
		echo "Stopped incomplete production migration task ${migration_arn}." >&2
	fi
}
trap cleanup_migration EXIT
aws_cli ecs wait tasks-stopped \
	--cluster "$PRODUCTION_CLUSTER" \
	--tasks "$migration_arn"
migration_exit="$(
	aws_cli ecs describe-tasks \
		--cluster "$PRODUCTION_CLUSTER" \
		--tasks "$migration_arn" \
		--query 'tasks[0].containers[0].exitCode' \
		--output text
)"
if [[ "$migration_exit" != "0" ]]; then
	aws_cli ecs describe-tasks \
		--cluster "$PRODUCTION_CLUSTER" \
		--tasks "$migration_arn" \
		--query 'tasks[0].{reason:stoppedReason,containerReason:containers[0].reason}' \
		--output json >&2
	exit 1
fi
migration_complete=true

target_group="$(
	aws_cli elbv2 describe-target-groups \
		--names "$PRODUCTION_TARGET_GROUP" \
		--query 'TargetGroups[0].TargetGroupArn' \
		--output text
)"
deployment_configuration="{\"maximumPercent\":200,\"minimumHealthyPercent\":100,\"deploymentCircuitBreaker\":{\"enable\":true,\"rollback\":true},\"alarms\":{\"alarmNames\":[\"${ROLLBACK_ALARM}\"],\"enable\":true,\"rollback\":true}}"
service_status="$(
	aws_cli ecs describe-services \
		--cluster "$PRODUCTION_CLUSTER" \
		--services "$PRODUCTION_SERVICE" \
		--query 'services[0].status' \
		--output text 2>/dev/null || true
)"
if [[ "$service_status" == "ACTIVE" ]]; then
	aws_cli ecs update-service \
		--cluster "$PRODUCTION_CLUSTER" \
		--service "$PRODUCTION_SERVICE" \
		--task-definition "$api_task" \
		--desired-count 2 \
		--health-check-grace-period-seconds 60 \
		--deployment-configuration "$deployment_configuration" \
		>/dev/null
else
	aws_cli ecs create-service \
		--cluster "$PRODUCTION_CLUSTER" \
		--service-name "$PRODUCTION_SERVICE" \
		--task-definition "$api_task" \
		--desired-count 2 \
		--launch-type FARGATE \
		--platform-version LATEST \
		--network-configuration "$network_configuration" \
		--load-balancers \
			"targetGroupArn=${target_group},containerName=control-plane,containerPort=8080" \
		--deployment-configuration "$deployment_configuration" \
		--health-check-grace-period-seconds 60 \
		--enable-ecs-managed-tags \
		--propagate-tags TASK_DEFINITION \
		--tags \
			key=Project,value=ao-cloud \
			key=Environment,value=production \
		>/dev/null
fi

aws_cli application-autoscaling register-scalable-target \
	--service-namespace ecs \
	--scalable-dimension ecs:service:DesiredCount \
	--resource-id "service/${PRODUCTION_CLUSTER}/${PRODUCTION_SERVICE}" \
	--min-capacity 2 \
	--max-capacity 6 \
	>/dev/null
aws_cli application-autoscaling put-scaling-policy \
	--service-namespace ecs \
	--scalable-dimension ecs:service:DesiredCount \
	--resource-id "service/${PRODUCTION_CLUSTER}/${PRODUCTION_SERVICE}" \
	--policy-name ao-cloud-production-cpu \
	--policy-type TargetTrackingScaling \
	--target-tracking-scaling-policy-configuration \
		'TargetValue=60,PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageCPUUtilization},ScaleOutCooldown=60,ScaleInCooldown=300' \
	>/dev/null

aws_cli ecs wait services-stable \
	--cluster "$PRODUCTION_CLUSTER" \
	--services "$PRODUCTION_SERVICE"
deployed_task="$(
	aws_cli ecs describe-services \
		--cluster "$PRODUCTION_CLUSTER" \
		--services "$PRODUCTION_SERVICE" \
		--query 'services[0].taskDefinition' \
		--output text
)"
if [[ "$deployed_task" != "$api_task" ]]; then
	echo "Production rolled back instead of deploying ${api_task}." >&2
	exit 1
fi

production_source="$(
	aws_cli ecs describe-task-definition \
		--task-definition "$deployed_task"
)"
if ! STAGING_IMAGE="$image" RELEASE="$release" SOURCE="$production_source" python3 - <<'PY'
import json
import os

source = json.loads(os.environ["SOURCE"])
container = next(
    item
    for item in source["taskDefinition"]["containerDefinitions"]
    if item["name"] == "control-plane"
)
environment = {item["name"]: item["value"] for item in container["environment"]}
if container["image"] != os.environ["STAGING_IMAGE"]:
    raise SystemExit("production image differs from staging")
if environment.get("AO_CLOUD_RELEASE") != os.environ["RELEASE"]:
    raise SystemExit("production release differs from staging")
PY
then
	exit 1
fi

./scripts/verify-ecs-service.py \
	--region "$REGION" \
	--cluster "$PRODUCTION_CLUSTER" \
	--service "$PRODUCTION_SERVICE" \
	--alarm "$ROLLBACK_ALARM" \
	--expected-task-definition "$api_task" >/dev/null
trap - EXIT

printf 'Promoted release %s\nImage digest: %s\nTask definition: %s\n' \
	"$release" \
	"$image_digest" \
	"$api_task"
