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
      # jql: project = APP AND statusCategory != Done ORDER BY updated DESC
```

Notes:
- `baseUrl` and `email` in `tracker:` override the environment values.
- `listIssues()` uses `tracker.jql` when provided, otherwise it builds a query from `projectKey` and AO filters.
- The plugin currently supports read paths only: fetch, inspect, prompt generation, and list/search.
