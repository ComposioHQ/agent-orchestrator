# Jira tracker plugin

Built-in Jira Cloud tracker support for AO.

## Configuration

Set auth with environment variables:

- `JIRA_BASE_URL`, for example `https://acme.atlassian.net`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Then configure a project tracker:

```yaml
projects:
  app:
    tracker:
      plugin: jira
      projectKey: APP
      # Optional overrides:
      # baseUrl: https://acme.atlassian.net
      # email: engineer@acme.com
      # issueTypeName: Bug
      # jql: project = APP AND statusCategory != Done ORDER BY updated DESC
```

Notes:
- `baseUrl` and `email` in `tracker:` override the environment values.
- `listIssues()` uses `tracker.jql` when provided, otherwise it builds a query from `projectKey` and AO filters.
- `createIssue()` requires `projectKey` and creates Jira issues as `Task` by default, or `tracker.issueTypeName` when set.
- `updateIssue()` supports state transitions, additive label updates with removals, comments, and best-effort assignee lookup. Jira's common `204 No Content` success responses are treated as success for transitions and field updates.
- Done-category statuses still preserve `Canceled`/`Cancelled` as AO `cancelled` instead of collapsing every done status to `closed`.
- Jira priorities are normalized to AO's 1-4 scale (`Highest`, `High`, `Medium`, `Low`).
