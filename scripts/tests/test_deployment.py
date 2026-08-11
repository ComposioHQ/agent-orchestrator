import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from lib.deployment import build_task_definition, validate_service


def task_source(environment="production"):
    return {
        "taskDefinition": {
            "taskRoleArn": f"arn:task:{environment}",
            "executionRoleArn": f"arn:execution:{environment}",
            "networkMode": "awsvpc",
            "requiresCompatibilities": ["FARGATE"],
            "cpu": "256",
            "memory": "512",
            "containerDefinitions": [
                {
                    "name": "control-plane",
                    "image": "old",
                    "environment": [
                        {"name": "AO_CLOUD_ENV", "value": environment},
                        {"name": "AO_CLOUD_PUBLIC_URL", "value": "https://api.aoagents.dev"},
                    ],
                    "secrets": [
                        {
                            "name": "AO_CLOUD_DATABASE_URL",
                            "valueFrom": f"arn:secret:ao-cloud/{environment}/database-url",
                        }
                    ],
                    "logConfiguration": {
                        "options": {
                            "awslogs-group": f"/ao-cloud/{environment}/control-plane"
                        }
                    },
                }
            ],
        }
    }


def healthy_service():
    task = "arn:task-definition:production:7"
    return (
        {
            "desiredCount": 2,
            "runningCount": 2,
            "pendingCount": 0,
            "taskDefinition": task,
            "deployments": [
                {
                    "status": "PRIMARY",
                    "rolloutState": "COMPLETED",
                    "taskDefinition": task,
                }
            ],
        },
        [{"taskDefinitionArn": task}, {"taskDefinitionArn": task}],
        [
            {"TargetHealth": {"State": "healthy"}},
            {"TargetHealth": {"State": "healthy"}},
        ],
    )


class TaskDefinitionTests(unittest.TestCase):
    def test_preserves_production_secrets_and_updates_release(self):
        payload = build_task_definition(
            task_source(),
            family="ao-cloud-production-api",
            container_name="control-plane",
            image="repository@sha256:digest",
            release="abc123",
            environment="production",
            log_group="/ao-cloud/production/control-plane",
            region="eu-north-1",
        )
        container = payload["containerDefinitions"][0]
        self.assertEqual(container["image"], "repository@sha256:digest")
        self.assertEqual(
            container["secrets"][0]["valueFrom"],
            "arn:secret:ao-cloud/production/database-url",
        )
        environment = {
            item["name"]: item["value"] for item in container["environment"]
        }
        self.assertEqual(environment["AO_CLOUD_RELEASE"], "abc123")
        self.assertEqual(environment["AO_CLOUD_ENV"], "production")

    def test_rejects_staging_reference_in_production_template(self):
        source = task_source()
        source["taskDefinition"]["containerDefinitions"][0]["secrets"][0][
            "valueFrom"
        ] = "arn:secret:ao-cloud/staging/database-url"
        with self.assertRaisesRegex(ValueError, "staging reference"):
            build_task_definition(
                source,
                family="ao-cloud-production-api",
                container_name="control-plane",
                image="repository@sha256:digest",
                release="abc123",
                environment="production",
                log_group="/ao-cloud/production/control-plane",
                region="eu-north-1",
            )


class ServiceValidationTests(unittest.TestCase):
    def test_accepts_stable_healthy_service(self):
        service, tasks, targets = healthy_service()
        validate_service(
            service=service,
            tasks=tasks,
            targets=targets,
            alarm_state="OK",
        )

    def test_rejects_empty_target_group(self):
        service, tasks, _ = healthy_service()
        with self.assertRaisesRegex(ValueError, "target count"):
            validate_service(
                service=service,
                tasks=tasks,
                targets=[],
                alarm_state="OK",
            )

    def test_rejects_mixed_task_revisions(self):
        service, tasks, targets = healthy_service()
        changed = copy.deepcopy(tasks)
        changed[1]["taskDefinitionArn"] = "arn:task-definition:production:6"
        with self.assertRaisesRegex(ValueError, "mixed"):
            validate_service(
                service=service,
                tasks=changed,
                targets=targets,
                alarm_state="OK",
            )

    def test_rejects_alarm_or_incomplete_rollout(self):
        service, tasks, targets = healthy_service()
        with self.assertRaisesRegex(ValueError, "alarm state"):
            validate_service(
                service=service,
                tasks=tasks,
                targets=targets,
                alarm_state="ALARM",
            )
        service["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        with self.assertRaisesRegex(ValueError, "not complete"):
            validate_service(
                service=service,
                tasks=tasks,
                targets=targets,
                alarm_state="OK",
            )


if __name__ == "__main__":
    unittest.main()
