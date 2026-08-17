# DeepSeek Display Name and Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the `deepseek-harness` agent as “DeepSeek” and render its existing official SVG in AO.

**Architecture:** Preserve `deepseek-harness` as the durable provider ID. Update the backend manifest and product UI label at their existing metadata boundaries, then connect the existing SVG through the renderer’s logo-source map.

**Tech Stack:** Go, React, TypeScript, Vitest, Testing Library, Electron/Vite.

## Global Constraints

- Keep the durable agent ID exactly `deepseek-harness`.
- Use the existing `frontend/src/renderer/assets/agents/deepseek-harness.svg` asset.
- Change user-facing display copy to exactly `DeepSeek`.
- Do not rename packages, migrations, runtime commands, or stored provider values.

---

### Task 1: Backend display metadata

**Files:**
- Modify: `backend/internal/adapters/agent/deepseekharness/deepseekharness_test.go`
- Modify: `backend/internal/adapters/agent/registry/registry_test.go`
- Modify: `backend/internal/adapters/agent/deepseekharness/deepseekharness.go`

**Interfaces:**
- Consumes: `deepseekharness.New().Manifest()` and registry lookup for `deepseek-harness`.
- Produces: a manifest whose `Name` is `DeepSeek` while its `ID` remains `deepseek-harness`.

- [ ] **Step 1: Change manifest and registry assertions to expect `DeepSeek` while continuing to assert ID `deepseek-harness`.**
- [ ] **Step 2: Run `go test ./internal/adapters/agent/deepseekharness ./internal/adapters/agent/registry` and verify failure reports `DeepSeek Harness`, not `DeepSeek`.**
- [ ] **Step 3: Change the adapter manifest `Name` to `DeepSeek`.**
- [ ] **Step 4: Re-run the focused Go tests and verify they pass.**

### Task 2: Product label and renderer icon

**Files:**
- Modify: `packages/product-ui/src/agents.ts`
- Modify: `frontend/src/renderer/components/AgentAvatar.test.tsx`
- Modify: `frontend/src/renderer/components/AgentAvatar.tsx`

**Interfaces:**
- Consumes: provider ID `deepseek-harness`, `AgentLogoSources`, and the existing SVG module.
- Produces: product label `DeepSeek` and an avatar `<img>` whose source contains `deepseek-harness.svg`.

- [ ] **Step 1: Strengthen the DeepSeek avatar test to require an `<img>` and a source containing `deepseek-harness.svg`; update the focused product-label expectation to `DeepSeek` if one exists.**
- [ ] **Step 2: Run the focused Vitest tests and verify the avatar assertion fails because the renderer emits the letter fallback.**
- [ ] **Step 3: Import `deepseek-harness.svg`, add the `deepseek-harness` logo-source mapping, and change the product label to `DeepSeek`.**
- [ ] **Step 4: Re-run the focused frontend tests and typecheck.**

### Task 3: Native app verification

**Files:**
- No source changes.

**Interfaces:**
- Consumes: the running Electron Forge development process.
- Produces: a restarted native AO app displaying the updated bundle.

- [ ] **Step 1: Restart the Electron main process because the asset import changes the renderer bundle.**
- [ ] **Step 2: Confirm Electron launches, the daemon listens on `127.0.0.1:3002`, and projects/sessions/agents requests return `200`.**
- [ ] **Step 3: Verify the native agent list shows `DeepSeek` with the SVG rather than a letter tile.**
- [ ] **Step 4: Commit the implementation with `fix: show DeepSeek name and icon`.**

