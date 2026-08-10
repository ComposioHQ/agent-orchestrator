# Agent Switch Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent switching use the New task composer interaction, add a functional target-model override for fresh and resumed sessions, and present post-admission progress in a terminal-scoped transition card.

**Architecture:** Extract the existing model picker into a reusable frontend component while keeping task and switch submission separate. Extend the existing switch command DTO through controller, service, fingerprint, and session manager; apply the override to the existing `AgentConfig` used by both launch and restore commands. Keep the durable switch saga unchanged and render its existing state through the terminal overlay.

**Tech Stack:** Go 1.26, React 19, TypeScript, Radix Dialog, TanStack Query, Tailwind CSS v4, Vitest, Go tests, generated OpenAPI/types.

## Global Constraints

- Claude Code and Codex are the only enabled switch targets.
- The optional note remains limited to 4,096 characters.
- The optional model remains limited to 256 characters.
- An empty model means no per-switch override and preserves the resolved project/provider default.
- The selected model applies to both fresh target launches and provider-native resumes.
- An accepted switch cannot be canceled.
- Do not change handoff construction, transcript fallback, durable switch states, recovery policy, or native-session retention.
- Do not add a SQLite migration or persist display-only phase state.
- Remove switch history from the configuration dialog and do not relocate it.

---

### Task 1: Reusable Agent Model Picker

**Files:**
- Create: `frontend/src/renderer/components/AgentModelPicker.tsx`
- Modify: `frontend/src/renderer/components/TaskComposer.tsx`
- Test: `frontend/src/renderer/components/TaskComposer.test.tsx`

**Interfaces:**
- Produces: `AgentModelPicker(props: AgentModelPickerProps)` with the current TaskModelPicker contract: `id`, `agentId`, `agentLabel`, `projectId`, `value`, `mode`, `onModelChange`, `onModeChange`, and `onWarningChange`, plus optional `disabled` for switch admission locking.
- Preserves: all task model catalog, custom model, mode-list, warning, refresh, and recent-selection behavior.

- [ ] **Step 1: Add a component-boundary regression test**

Add an assertion to the existing TaskComposer model tests that choosing an agent catalog model still submits that model after extraction:

```tsx
await user.click(screen.getByRole("button", { name: "Model" }));
await user.click(screen.getByText("Claude Opus"));
await user.click(screen.getByRole("button", { name: "Start task" }));
expect(requestBody()).toMatchObject({ model: "claude-opus-4-5" });
```

- [ ] **Step 2: Run the focused test and confirm the current behavior**

Run: `cd frontend && npm test -- --run src/renderer/components/TaskComposer.test.tsx`

Expected: PASS before extraction; this is a characterization test protecting the move.

- [ ] **Step 3: Extract the existing picker without changing behavior**

Move `TaskModelPicker` and its picker-only imports from `TaskComposer.tsx` into `AgentModelPicker.tsx`, export the component and props, and replace the local call with:

```tsx
<AgentModelPicker
  id={modelId}
  agentId={selectedAgent}
  agentLabel={selectedAgentLabel}
  projectId={projectId ?? ""}
  value={model}
  mode={mode}
  disabled={false}
  onWarningChange={setModelWarning}
  onModelChange={handleModelChange}
  onModeChange={handleModeChange}
/>
```

- [ ] **Step 4: Run the focused test after extraction**

Run: `cd frontend && npm test -- --run src/renderer/components/TaskComposer.test.tsx`

Expected: PASS with no snapshot, accessible-name, or request-body changes.

- [ ] **Step 5: Commit the extraction**

```bash
git add frontend/src/renderer/components/AgentModelPicker.tsx frontend/src/renderer/components/TaskComposer.tsx frontend/src/renderer/components/TaskComposer.test.tsx
git commit -m "refactor: share agent model picker"
```

---

### Task 2: Functional Switch Model Override

**Files:**
- Modify: `backend/internal/domain/agent_switching.go`
- Modify: `backend/internal/domain/agent_switching_test.go`
- Modify: `backend/internal/session_manager/agent_switching.go`
- Modify: `backend/internal/session_manager/agent_switching_test.go`
- Modify: `backend/internal/service/session/agent_switching.go`
- Modify: `backend/internal/httpd/controllers/dto.go`
- Modify: `backend/internal/httpd/controllers/sessions.go`
- Modify: `backend/internal/httpd/controllers/sessions_test.go`
- Modify: call sites of `ComputeAgentSwitchRequestFingerprint` under `backend/internal/storage/sqlite/store/*_test.go`
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`
- Regenerate: `frontend/src/api/schema.ts`

**Interfaces:**
- Changes: `ComputeAgentSwitchRequestFingerprint(sessionID, targetHarness, note, model string)`.
- Changes: `SwitchAgentRequest`, `session.SwitchAgentInput`, and `sessionmanager.SwitchAgentConfig` gain `Model string`.
- Changes: `prepareTargetActivation(ctx context.Context, store ports.AgentSwitchStore, rec domain.SessionRecord, project domain.ProjectRecord, agent ports.Agent, caps ports.ContinuationCapabilities, sw domain.AgentSwitch, modelOverride string)` applies the normalized override to the target `AgentConfig`.

- [ ] **Step 1: Write fingerprint and launch/restore tests**

Add domain coverage proving model normalization and identity:

```go
base := ComputeAgentSwitchRequestFingerprint("session-1", HarnessCodex, "note", "gpt-5.4")
same := ComputeAgentSwitchRequestFingerprint("session-1", HarnessCodex, "note", "  gpt-5.4  ")
other := ComputeAgentSwitchRequestFingerprint("session-1", HarnessCodex, "note", "gpt-5.4-mini")
if base != same || base == other { t.Fatal("model must be normalized and fingerprinted") }
```

Extend `switchTestAgent` to record `cfg.Config.Model` for `GetLaunchCommand` and `GetRestoreCommand`. Add one fresh-target test and one resume-candidate test that switch with `Model: " target-model "` and assert both command paths receive `target-model`.

- [ ] **Step 2: Write controller validation and projection tests**

Extend the successful switch request test to send `"model":"gpt-5.4"` and assert the fake service receives it. Add a validation row with 257 model characters expecting `MODEL_TOO_LONG` and HTTP 400.

- [ ] **Step 3: Run focused backend tests and observe failures**

Run:

```bash
cd backend
go test ./internal/domain ./internal/session_manager ./internal/httpd/controllers
```

Expected: FAIL until the new request field, fingerprint argument, and activation override are implemented.

- [ ] **Step 4: Implement normalized request propagation**

Use the following shapes:

```go
type SwitchAgentRequest struct {
    TargetHarness  domain.AgentHarness `json:"targetHarness" enum:"claude-code,codex" description:"Agent harness to continue the logical AO session with."`
    Model          string              `json:"model,omitempty" maxLength:"256" description:"Optional model override for the target agent launch or resume."`
    Note           string              `json:"note,omitempty" maxLength:"4096" description:"Optional user guidance included in the bounded handoff context."`
    IdempotencyKey string              `json:"idempotencyKey,omitempty" maxLength:"128" description:"Optional retry key. Reusing it with a different request is rejected."`
}
```

```go
type SwitchAgentConfig struct {
    TargetHarness  domain.AgentHarness
    Model          string
    Note           string
    IdempotencyKey string
}
```

Normalize model once at admission with `strings.TrimSpace`, include it in the fingerprint payload, and reject values over 256 characters in the controller before durable admission.

- [ ] **Step 5: Apply the override to launch and resume**

Immediately after resolving the effective target config in `prepareTargetActivation`:

```go
config := effectiveAgentConfig(rec.Kind, project.Config)
if model := strings.TrimSpace(modelOverride); model != "" {
    config.Model = model
}
```

Pass this same `config` through the existing `LaunchConfig`, preflight `RestoreConfig`, and final prompt-bound launch/restore rebuild.

- [ ] **Step 6: Update all fingerprint call sites and run focused tests**

Pass `""` as the model at existing fixture call sites, then run:

```bash
cd backend
go test ./internal/domain ./internal/session_manager ./internal/service/session ./internal/httpd/controllers ./internal/storage/sqlite/store
```

Expected: PASS.

- [ ] **Step 7: Regenerate and verify the API contract**

Run:

```bash
npm run api
cd backend && go test ./internal/httpd/...
```

Expected: OpenAPI and `frontend/src/api/schema.ts` include optional `model`; drift tests pass.

- [ ] **Step 8: Commit the backend contract**

```bash
git add backend/internal frontend/src/api/schema.ts
git commit -m "feat: select model when switching agents"
```

---

### Task 3: Composer-Style Switch Dialog

**Files:**
- Modify: `frontend/src/renderer/hooks/useSwitchAgent.ts`
- Modify: `frontend/src/renderer/components/SwitchAgentDialog.tsx`
- Modify: `frontend/src/renderer/components/SwitchAgentDialog.test.tsx`
- Modify: `frontend/src/renderer/i18n/en.json`
- Modify: `frontend/src/renderer/i18n/de.json`
- Modify: `frontend/src/renderer/i18n/es.json`
- Modify: `frontend/src/renderer/i18n/fr.json`
- Modify: `frontend/src/renderer/i18n/ja.json`
- Modify: `frontend/src/renderer/i18n/ko.json`
- Modify: `frontend/src/renderer/i18n/pt-BR.json`
- Modify: `frontend/src/renderer/i18n/zh-CN.json`
- Modify: switch-history assertions in `frontend/src/renderer/components/TerminalSwitchAgentButton.test.tsx`

**Interfaces:**
- Changes: `SwitchAgentInput` gains `model: string` and the POST body omits it when trimmed empty.
- Consumes: `AgentModelPicker` from Task 1.
- Preserves: durable admission/recovery rendering, non-dismissible pending admission, and close-on-202 behavior.

- [ ] **Step 1: Write dialog behavior tests**

Cover the agreed behavior:

```tsx
expect(screen.getByRole("dialog", { name: "Switch agent" }).querySelector(".composer-prompt-surface")).not.toBeNull();
expect(screen.queryByText("Switch history")).not.toBeInTheDocument();
expect(screen.getByText("Claude Code → Codex")).toBeInTheDocument();
```

Select a catalog model, submit, and assert:

```tsx
expect(switchMocks.mutate).toHaveBeenCalledWith(
  expect.objectContaining({ targetHarness: "codex", model: "gpt-5.4" }),
  { onSuccess: expect.any(Function) },
);
```

Also assert changing the target clears the previous model, default selection submits `model: ""`, and pending admission disables Cancel, note, agent, model, and Switch.

- [ ] **Step 2: Run focused frontend tests and observe failures**

Run:

```bash
cd frontend
npm test -- --run src/renderer/components/SwitchAgentDialog.test.tsx src/renderer/components/TerminalSwitchAgentButton.test.tsx
```

Expected: FAIL against the current settings-style dialog and missing model request.

- [ ] **Step 3: Extend the mutation request**

Add `model` to `SwitchAgentInput`; normalize it and include `body.model` only when non-empty:

```ts
const normalizedModel = model.trim();
if (normalizedModel) body.model = normalizedModel;
```

- [ ] **Step 4: Rebuild the dialog with the New task shell**

Use the same portal structure and frame classes as `NewTaskDialog`:

```tsx
<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
  <Dialog.Title className="settings-dialog-title px-4 pt-3">{t("switchAgent.title")}</Dialog.Title>
  <p className="px-4 pt-1 text-caption text-muted-foreground">{source} → {target}</p>
  <form className="composer-prompt-surface flex flex-col" onSubmit={submit}>
    <textarea id={noteId} className="min-h-(--size-composer-prompt-min) w-full resize-none bg-transparent px-4 pb-3 pt-4 text-md leading-relaxed text-foreground outline-none placeholder:text-passive" />
    <div className="composer-toolbar">
      <div className="composer-run-controls">
        <div className="composer-toolbar-slot"><SwitchTargetPicker currentHarness={session.provider} disabled={admissionPending} value={targetHarness} onChange={changeTarget} /></div>
        <span className="composer-toolbar-divider" aria-hidden="true" />
        <div className="composer-toolbar-slot">
          <AgentModelPicker
            id={modelId}
            agentId={targetHarness}
            agentLabel={agentLabel(targetHarness)}
            projectId={session.workspaceId}
            value={model}
            mode={mode}
            disabled={admissionPending}
            onWarningChange={setModelWarning}
            onModelChange={changeModel}
            onModeChange={changeMode}
          />
        </div>
      </div>
      <Button type="button" variant="outline" onClick={cancel}>{t("confirm.cancel")}</Button>
      <Button type="submit" variant="primary">{t("switchAgent.confirm")}</Button>
    </div>
  </form>
</Dialog.Content>
```

Define local `SwitchTargetPicker`, `changeTarget`, and `cancel` functions in `SwitchAgentDialog.tsx`; the picker renders the existing avatar/status option rows through `SettingsOptionMenu`, disables the current provider, and disables unsupported providers with the coming-soon label. Supply the complete required `AgentModelPicker` callback props shown in Task 1. Place the note textarea in the composer body with `resize-none`, put target and `AgentModelPicker` in `composer-run-controls`, and place Cancel/Switch at the right of `composer-toolbar`. Remove history fetching/presentation used only by the deleted history list, while retaining the active/recovery query required for admission gating and details.

- [ ] **Step 5: Update formal localized copy**

Add keys for the live route label, model accessible name, and optional-note placeholder to all eight locale files. Remove only keys proven unused after history removal; retain status and error keys shared by other switch surfaces.

- [ ] **Step 6: Run dialog and type checks**

Run:

```bash
cd frontend
npm test -- --run src/renderer/components/SwitchAgentDialog.test.tsx src/renderer/components/TerminalSwitchAgentButton.test.tsx src/renderer/components/TaskComposer.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the dialog**

```bash
git add frontend/src/renderer
git commit -m "feat: match switch dialog to task composer"
```

---

### Task 4: Terminal Transition Card and Integrated Verification

**Files:**
- Modify: `frontend/src/renderer/components/CenterPane.tsx`
- Modify: `frontend/src/renderer/components/CenterPane.test.tsx`
- Modify: `frontend/src/renderer/styles.css`

**Interfaces:**
- Consumes: existing `AgentSwitchPresentation` and durable switch summary.
- Preserves: terminal input gating, source permission lane, shell interaction, settlement focus, success, failure, and recovery semantics.

- [ ] **Step 1: Write transition-card boundary tests**

For ordinary progress assert that the terminal overlay owns a visible card and terminal-only blur:

```tsx
const overlay = screen.getByTestId("agent-switch-terminal-overlay");
expect(overlay).toHaveClass("backdrop-blur-[3px]");
expect(within(overlay).getByTestId("agent-switch-transition-card")).toBeInTheDocument();
expect(within(overlay).getByTestId("agent-switch-transition-card")).toContainElement(
  within(overlay).getByText("Preparing handoff"),
);
```

Retain existing tests proving an auxiliary shell is not blurred or made inert and the arrowhead does not animate.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `cd frontend && npm test -- --run src/renderer/components/CenterPane.test.tsx`

Expected: FAIL because ordinary progress currently floats directly on the overlay without a card.

- [ ] **Step 3: Add the terminal transition card**

Wrap the ordinary provider-transfer content in a token-based surface:

```tsx
<div
  data-testid="agent-switch-transition-card"
  className="flex max-w-lg flex-col items-center gap-5 rounded-xl border border-border-strong bg-surface/95 px-8 py-6 text-center shadow-xl"
>
  {/* existing provider marks, animated line/static ArrowRight, title, description, and progress */}
</div>
```

Keep `absolute inset-0 items-center justify-center bg-terminal/95 backdrop-blur-[3px]` on the terminal overlay only. Do not add any app-wide overlay after admission.

- [ ] **Step 4: Refine motion and reduced-motion styles**

Keep the transfer pulse animation on the line only. Keep the `ArrowRight` outside animated elements. Add subtle current-step dot animation only when motion is allowed; use the existing reduced-motion media query to make the transfer and step emphasis static.

- [ ] **Step 5: Run focused frontend verification**

Run:

```bash
cd frontend
npm test -- --run src/renderer/components/CenterPane.test.tsx src/renderer/components/SwitchAgentDialog.test.tsx src/renderer/components/TerminalSwitchAgentButton.test.tsx src/renderer/components/TaskComposer.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Run grouped backend and contract verification**

Run:

```bash
cd backend
go test -p 4 ./internal/domain ./internal/session_manager ./internal/service/session ./internal/httpd/... ./internal/storage/sqlite/store
```

Expected: PASS.

- [ ] **Step 7: Verify in the native Electron app**

Restart the running Forge process because the generated daemon and API contract changed. In isolated mode verify:

1. Open a Claude Code worker and invoke Switch agent.
2. Confirm the whole app blurs behind the New task-style composer.
3. Choose Codex and an explicit model, then cancel; confirm no switch begins.
4. Reopen and submit; confirm the full-window overlay closes after admission.
5. Confirm only the worker terminal is blurred and the transition content is inside the card.
6. Repeat the dialog/model path from a Codex worker to Claude Code.

- [ ] **Step 8: Commit final presentation changes**

```bash
git add frontend/src/renderer/components/CenterPane.tsx frontend/src/renderer/components/CenterPane.test.tsx frontend/src/renderer/styles.css
git commit -m "feat: present agent switch progress in terminal card"
```

- [ ] **Step 9: Final branch check**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors and a clean worktree.
