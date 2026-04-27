---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
"@aoagents/ao-plugin-scm-github": patch
"@aoagents/ao-plugin-scm-gitlab": patch
"@aoagents/ao-plugin-tracker-github": patch
"@aoagents/ao-plugin-tracker-gitlab": patch
---

Make `ProjectConfig.repo` optional to support projects without a configured remote.

**Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
throws with a descriptive error.
