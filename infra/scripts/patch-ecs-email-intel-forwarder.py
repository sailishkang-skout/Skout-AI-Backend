#!/usr/bin/env python3
"""Patch live ECS task defs to inject email-intel-forwarder secrets (SkoutDev).

Does not print secret values. Requires secret PREFIX/email-intel-forwarder to exist.
"""
from __future__ import annotations

import json
import subprocess
import sys

REGION = "us-east-1"
PREFIX = sys.argv[1] if len(sys.argv) > 1 else "SkoutDev"
CLUSTER = f"{PREFIX}-cluster"
SECRET_NAME = f"{PREFIX}/email-intel-forwarder"


def aws_json(args: list[str]):
    out = subprocess.check_output(["aws", *args, "--region", REGION, "--output", "json"], text=True)
    return json.loads(out)


def secret_arn() -> str:
    d = aws_json(["secretsmanager", "describe-secret", "--secret-id", SECRET_NAME])
    return d["ARN"]


def current_task_def(service: str) -> str:
    d = aws_json(
        ["ecs", "describe-services", "--cluster", CLUSTER, "--services", service]
    )
    return d["services"][0]["taskDefinition"]


def register_with_secrets(task_def_arn: str, extra_secrets: list[dict], container_name: str | None = None) -> str:
    td = aws_json(["ecs", "describe-task-definition", "--task-definition", task_def_arn])[
        "taskDefinition"
    ]
    containers = td["containerDefinitions"]
    # Prefer main app container (not Datadog sidecar)
    target = None
    for c in containers:
        if container_name and c["name"] == container_name:
            target = c
            break
    if target is None:
        for c in containers:
            if c["name"] in ("Container", "email-intel-api", "email-intel-worker") or not str(
                c.get("image", "")
            ).startswith("public.ecr.aws/datadog"):
                if "datadog" not in c["name"].lower():
                    target = c
                    break
    if target is None:
        target = containers[0]

    existing = {s["name"]: s for s in target.get("secrets") or []}
    for s in extra_secrets:
        existing[s["name"]] = s
    target["secrets"] = list(existing.values())

    # Strip response-only fields
    for k in (
        "taskDefinitionArn",
        "revision",
        "status",
        "requiresAttributes",
        "compatibilities",
        "registeredAt",
        "registeredBy",
    ):
        td.pop(k, None)

    payload = {
        "family": td["family"],
        "taskRoleArn": td.get("taskRoleArn"),
        "executionRoleArn": td.get("executionRoleArn"),
        "networkMode": td.get("networkMode"),
        "containerDefinitions": containers,
        "requiresCompatibilities": td.get("requiresCompatibilities"),
        "cpu": td.get("cpu"),
        "memory": td.get("memory"),
        "volumes": td.get("volumes") or [],
    }
    if td.get("runtimePlatform"):
        payload["runtimePlatform"] = td["runtimePlatform"]

    tmp = f"/tmp/td-{td['family']}.json"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    new = aws_json(["ecs", "register-task-definition", "--cli-input-json", f"file://{tmp}"])
    return new["taskDefinition"]["taskDefinitionArn"]


def update_service(service: str, task_def_arn: str):
    aws_json(
        [
            "ecs",
            "update-service",
            "--cluster",
            CLUSTER,
            "--service",
            service,
            "--task-definition",
            task_def_arn,
            "--force-new-deployment",
        ]
    )
    print(f"updated {service} -> {task_def_arn.split('/')[-1]}")


def main():
    arn = secret_arn()
    print(f"using secret {SECRET_NAME}")

    api_secrets = [
        {
            "name": "EMAIL_INTEL_EXTERNAL_API_KEY",
            "valueFrom": f"{arn}:EMAIL_INTEL_EXTERNAL_API_KEY::",
        },
        {
            "name": "EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID",
            "valueFrom": f"{arn}:EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID::",
        },
    ]
    ei_secrets = [
        {
            "name": "SKOUT_CANONICAL_EVIDENCE_URL",
            "valueFrom": f"{arn}:SKOUT_CANONICAL_EVIDENCE_URL::",
        },
        {
            "name": "SKOUT_CANONICAL_EVIDENCE_TOKEN",
            "valueFrom": f"{arn}:SKOUT_CANONICAL_EVIDENCE_TOKEN::",
        },
    ]

    # API
    api_td = current_task_def("api")
    new_api = register_with_secrets(api_td, api_secrets, container_name="Container")
    update_service("api", new_api)

    # Email-Intel api + worker
    for svc in ("email-intel-api", "email-intel-worker"):
        td = current_task_def(svc)
        new_td = register_with_secrets(td, ei_secrets)
        update_service(svc, new_td)

    print("done — deployments rolling")


if __name__ == "__main__":
    main()
