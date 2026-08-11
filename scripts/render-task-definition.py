#!/usr/bin/env python3

import argparse
import json
import sys

from lib.deployment import build_task_definition


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--environment", choices=("staging", "production"), required=True)
    parser.add_argument("--log-group", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--runtime-database-user", default="")
    args = parser.parse_args()
    source = json.load(sys.stdin)
    payload = build_task_definition(
        source,
        family=args.family,
        container_name=args.container,
        image=args.image,
        release=args.release,
        environment=args.environment,
        log_group=args.log_group,
        region=args.region,
        runtime_database_user=args.runtime_database_user,
    )
    json.dump(payload, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
