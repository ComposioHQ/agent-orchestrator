# Project Permission Defaults Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement the bounded backend task while the parent wires the shared UI.

**Goal:** Default new project sessions to Auto and let users remember a chosen composer permission for future sessions.

**Architecture:** Resolve defaults in session_manager. Save only permissions through a focused project daemon route backed by existing config. Annotate provider choices with canonical permission modes in the daemon; render those annotations without guessing in React.

**Tech Stack:** Go, SQLite/sqlc, OpenAPI, React, TanStack Query, Vitest.

- [x] Backend: test `effectiveAgentConfig` for worker/orchestrator, unset -> auto, explicit project/role/spawn overrides preserved; implement unset fallback in `backend/internal/session_manager/manager.go`.
- [x] Backend: add `PATCH /projects/{id}/permissions` accepting `{permissions: "auto"}` (all canonical modes); atomically save base permissions and clear permission-only role overrides, preserving other config. Validate missing/invalid IDs and modes. Regenerate using `npm run api` (and sqlc if needed).
- [x] Backend: annotate known provider mode choices with `permissionMode`; test Claude mappings and unknown modes, retain per-session selection correctly.
- [x] UI: extend `TurnSettingsBar.tsx`, `ChatWorkspace.tsx`, and `SessionChatSurface.tsx` to pass a remember action for both session roles. Permission selection alone stays session-only. Save the currently confirmed mode with a dedicated mutation hook, invalidate project/workspace queries, display failures and disable overlapping writes.
- [x] UI: test native and provider menus, mapped vs unmapped choices, pending/error states, and empty orchestrator permission visibility. Run `npm test -- src/renderer/components/chat/TurnSettingsBar.test.tsx src/renderer/components/chat/ChatWorkspace.test.tsx src/renderer/components/chat/SessionChatSurface.test.tsx` from frontend.
- [x] Verify: frontend typecheck and full Vitest suite; backend targeted tests followed by build/test/vet and race as feasible. Inspect rendered menu in preview with `ao preview`; report exact environment limitations. Review combined diff before completion.

Verification completed with broader-suite gaps documented in `../specs/2026-09-05-project-permissions-validation.md`. The full frontend run was attempted and stopped after unrelated timeouts; it is not claimed as passing. No PR or publication performed.
