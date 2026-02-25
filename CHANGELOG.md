# Changelog

## [2026-02-25]

- fix: add default messages for send-to-agent reactions (ee4e742)
- config: add github tracker to all projects (566c858)
- feat: add systemd user-units for reliable service management (077c5f2)
- feat: auto-spawn agents for open issues on `ao start` (168595d)
- feat: add agent-orchestrator as a managed project (5140107)
- feat: add `ao self-update` for controlled self-deployment (071637d)
- feat: add automatic PR code review on review_pending state (4eb50ec)
- fix: pass notifier config to plugins via extractPluginConfig (70b82b7)

## [2026-02-24]

- docs: add OpenClaw instance overview to README (669b0ae)
- feat: bind dashboard and dev server to 0.0.0.0 for LAN access (8282ee2)
- Merge pull request #154 from suraj-markup/suraj/codex-maturity (ae508c9)
- test(agent-codex): update tests for correct Codex CLI flags (0a5fea1)
- fix(agent-codex): use correct Codex CLI flags and remove dead code (584ca1d)
- fix: add agent field to readMetadata return mapping (89fc336)
- fix: persist agent name in metadata so lifecycle resolves correct plugin (46b0d1a)
- test: add tests for --agent override and codex plugin registration (2bdc6bb)
- fix(agent-codex): suppress no-useless-escape lint for bash template literals (b096569)

## [2026-02-23]

- feat(cli): add --agent flag to override agent plugin at spawn time (71ee3a2)
- feat(agent-codex): mature Codex plugin to match Claude Code support (e410079)
- docs: README update (#156) (c820728)

## [2026-02-22]

- ci: add workflow_dispatch trigger to release workflow (#153) (5ffd063)
- chore: remove static CLAUDE.orchestrator.md (#143) (3c16088)

## [2026-02-21]

- docs: redesign README based on competitive research (#132) (ade1322)

## [2026-02-20]

- feat(web): redesign dashboard, session detail, and orchestrator terminal (#125) (40c1906)

## [2026-02-19]

- feat: session title fallback chain for PR-less sessions (#105) (0e2ca70)
- docs: update port references to reflect configurability (#122) (4505071)
- fix: auto-detect free port in `ao init` instead of hardcoding 3000 (#120) (9822aba)
- fix: tab title followups — empty name guard, dedupe truncation (#121) (0e53384)
- feat: dynamic tab titles and health-aware favicons (#111) (b605ee8)
- feat: configurable terminal server ports for multi-dashboard support (#113) (520010d)
- fix: restore archived sessions that were killed/cleaned up (#110) (1a3cad9)
- fix: destroy old runtime before restore, cleanup clone on failure (#109) (1e30411)
- feat: implement session restore for crashed/exited agents (#104) (65fa811)

## [2026-02-18]

- feat: first-class orchestrator session + file-based system prompt (#101) (de6653e)
- fix: three spawn regressions from PR #88 session-manager refactor (#100) (767558f)
- fix: dashboard config discovery + CLI service layer refactoring (#70) (59c490a)
- refactor: delegate CLI commands to core SessionManager (#88) (b75c6b0)
- fix: decouple activity detection from runtimeHandle (#89) (0691c20)
- feat: overhaul orchestrator prompt with comprehensive CLI reference (#90) (adc17c8)
- fix: activity detection — fix path encoding bug, add ready state (#71) (7395718)
- fix: terminal servers compatible with hash-based architecture (#87) (dcfee04)
- fix: clean up hash-based test directories in afterEach (#86) (9c5927a)
- fix: migrate to hash-based project isolation architecture (5997102)

## [2026-02-17]

- fix: clean Next.js build artifacts in setup script (#68) (5fe4767)

## [2026-02-16]

- feat: seamless onboarding with enhanced documentation (#66) (eaea131)
- fix: increase delays in spawn prompt submission to ensure Enter is processed (#62) (dbeb8d9)
- fix: improve 'Ask Agent to Fix' button UX (#61) (cd9003a)
- fix: prevent merged PRs from showing 'Merge conflicts' status (#60) (2fce2c7)
- feat: implement comprehensive security audit and secret leak prevention (#67) (66005c0)
- refactor: replace magic strings with constants for status enums (#64) (1cb52c1)
- fix: unset CLAUDECODE in spawned sessions to prevent nested session errors (a686645)
- feat: wire up live activity detection for agent sessions (#45) (79aac7c)
- feat: implement ao start command for unified orchestrator startup (#42) (77323cb)
- feat: validate tracker issues on spawn with fail-fast behavior (#44) (1cd7c51)
- feat: implement DirectTerminal with XDA clipboard support (#55) (bba1316)

## [2026-02-15]

- fix: prevent "Leave Site?" dialog on session pages (#47) (2a3723b)
- fix: remove redundant attention level badge from session detail (#41) (7ce8dc3)
- fix: recognize terminated/done session states and hide terminal for dead sessions (#40) (de662dc)
- feat: publish to npm under @composio scope (#32) (21335db)
- fix: address bugbot comments - deduplicate resolveProject, generic error messages (#39) (6845f45)
- fix: resolve dashboard GitHub API rate limiting and PR enrichment (#37) (c2a0aae)
- fix: address remaining bugbot review issues from PR #26 (#33) (1bd597c)
- docs: comprehensively optimize CLAUDE.md for agent effectiveness (#38) (8db5f2b)
- docs: condense CLAUDE.md for token efficiency (#36) (baaabe5)
- feat: auto-update session metadata via Claude Code hooks (#34) (8e5b23e)
- Wire xterm.js terminal embed into web dashboard (#29) (620bad9)

## [2026-02-14]

- Merge pull request #31 from ComposioHQ/fix/ci-status-merged-prs (05e537c)
- fix: don't report CI as failing for merged/closed PRs (95dfaa4)
- Merge pull request #30 from ComposioHQ/fix/working-zone-expanded (77c9411)
- feat: layered prompt system for agent sessions (#27) (90111da)
- fix: expand WORKING attention zone by default (a20cd9a)
- fix: wire dashboard to real session data with PR enrichment (#28) (24f1401)
- feat: wire web dashboard API routes to real core services (#26) (b743142)
- feat: enrich ao status with PR, CI, review, threads, and activity columns (#25) (e5f0c08)
- fix: remove sessions/ subdirectory from metadata paths (#24) (85ec8e8)
- fix: detect agent exit for all agent types, not just idle-reporting ones (#22) (1eba420)
- chore: remove unused makeActions helper from event-factory (#23) (7ae6ab1)
- feat: notifier-composio plugin + integration tests for all plugins (#7) (90f14a6)
- feat: implement CLI with all commands (init, status, spawn, session, send, review-check, dashboard, open) (#6) (06b5ec3)
- feat: implement SCM and tracker plugins (github, linear) (#4) (8707faf)
- feat: implement runtime and workspace plugins (tmux, process, worktree, clone) (#2) (925a7aa)
- fix: upgrade @testing-library/jest-dom for vitest 2.x type compatibility (#21) (e450fed)
- feat: implement web dashboard with attention-zone UI and API routes (#1) (343c8a6)
- fix: address Bugbot followup — stale paths in JSDoc, unused exports (#20) (7dd7de6)
- feat: agent plugins, OpenCode plugin, integration tests, CI (#5) (4b6d62d)
- Merge pull request #3 from ComposioHQ/feat/INT-1327 (134bc6e)
- fix: filter invalid session IDs in listMetadata to prevent downstream crashes (f2e0ac1)
- fix: restrict temp file permissions, validate session prefix format (660b8bb)
- fix: suppress immediate notification when send-to-agent reaction handles event (4028e5b)
- fix: notify on significant transitions, preserve stuck state on probe failure (9e7a767)
- refactor: remove EventBus, simplify lifecycle manager (95fd47e)

## [2026-02-13]

- fix: use literal mode for tmux send-keys, prune stale lifecycle trackers (4c47a42)
- fix: allow notify reactions when auto is false, clean up reserved IDs on spawn failure (07b3a55)
- fix: use handle.runtimeName for plugin lookup, atomic session ID reservation (65787f0)
- fix: runtime plugin lookup, post-create guard, restart transition detection (a225bc1)
- fix: prevent project workspace deletion and agent config workspace leak (88ea7d1)
- fix: session recovery, reaction config merge, summary priority (ad0b450)
- fix: ignore next-env.d.ts in ESLint config (24391c8)
- fix: add missing cleanup status to VALID_STATUSES set (f6f5e24)
- fix: execute all-complete reaction and guard workspace postCreate (4a80450)
- fix: address all review comments, lint/format, bugbot issues (2ecb011)
- fix: address codex review — path traversal, retry logic, type safety (c49649c)
- fix: address PR review — unsafe casts, tmux race, concurrent polling (d6ec954)
- test: add comprehensive unit tests for all core services (2b9a28a)
- feat: implement core services (metadata, event-bus, tmux, session-manager, lifecycle-manager) (de86054)
- fix: CI handles Next.js build separately, fix web tsconfig (#14) (0c535c9)
- chore: add ESLint, Prettier, CI workflow, and comprehensive CLAUDE.md conventions (c8061ce)
- feat: scaffold TypeScript monorepo with all plugin interfaces (5058c40)
- docs: add parallel implementation plan with 7-agent work breakdown (36b0792)
- docs: update architecture with push-first notification model (3eecca8)
- docs: add competitive research and architecture design artifacts (74001b2)
- feat: add agent-orchestrator (ao) as a self-hosting project (1601ad7)
- rename CLAUDE.local.md to CLAUDE.orchestrator.md (c16103f)
- feat: initial commit with orchestrator scripts and dev instructions (0273e8f)
