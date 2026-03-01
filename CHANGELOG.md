# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **GitLab SCM plugin** (`scm-gitlab`): MR detection, CI pipeline tracking via `glab api`, approval-based review model, merge readiness checks including conflict detection and unresolved discussion blocking. Uses the `glab` CLI for all API interactions.
- **GitLab Tracker plugin** (`tracker-gitlab`): Issue CRUD, filtered listing, configurable `host` parameter for self-hosted GitLab instances. Labels come as flat string arrays (unlike GitHub's `[{name}]` format), assignees use `username` (not `login`).
- Registered both plugins in core plugin registry, CLI, web dashboard, and config example.
- 87 new tests across both plugins (48 scm-gitlab, 39 tracker-gitlab).

### Known Limitations

- GitLab API does not expose MR-level addition/deletion counts; `getPRSummary` returns 0/0 for these fields.
- GitLab uses an approval model rather than GitHub-style reviews. No `changes_requested` review state exists; `getReviewDecision` uses the `approved` boolean and `approvals_left` count as a proxy.
- `issueUrl()` is synchronous and cannot call the API, so it relies on the configurable `host` parameter (defaults to `gitlab.com`).
