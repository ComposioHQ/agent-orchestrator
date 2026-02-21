# tracker-gitlab plugin

Tracker plugin for GitLab Issues.

## Install

Add the package to your workspace (if you keep plugins as separate packages).

## Configuration

Example agent-orchestrator config:

```yaml
trackers:
  - name: gitlab-prod
    plugin: gitlab
    token: ${GITLAB_TOKEN}
    baseUrl: https://gitlab.com/api/v4       # optional, defaults to https://gitlab.com/api/v4
    webhookSecret: ${GITLAB_WEBHOOK_SECRET}  # optional, for validating webhooks