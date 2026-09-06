package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Recovery for spawns the daemon did not finish.
//
// A spawn is a sequence of side effects — a row, a worktree, provisioning,
// attachments, a provider process — and a crash or a cancelled request can land
// between any two of them. The durable spawn phase says which of those side
// effects are real, and this file turns that into the one safe action:
//
//	preparing, no workspace   nothing outside the row exists; drop the seed
//	preparing, with workspace an older build's row; treat it as workspace_ready
//	workspace_ready           the worktree is the user's; reopen it and start
//	                          the agent fresh, replaying the original prompt
//	controller_ready          a controller identity was committed; the ordinary
//	                          native-resume path owns this session
//
// The one thing recovery must never do is resume natively from a spawn that
// never committed a controller: there is no provider conversation to resume,
// and pretending otherwise either fails obscurely or silently drops the user's
// original prompt.

// recoverInterruptedSpawnIfNeeded handles a session whose spawn never reached
// controller_ready. handled=false means the session is fully spawned and the
// caller's ordinary path applies.
func (m *Manager) recoverInterruptedSpawnIfNeeded(ctx context.Context, rec domain.SessionRecord) (bool, error) {
	// Two rows this path must never touch, checked once up front so no branch
	// below can miss one:
	//   - an untracked harness, which never leaves controller_ready anyway, but
	//     could arrive from a hand edit, an older backup, or a future build;
	//   - a row naming a provider or native conversation, which proves a
	//     controller did exist whatever the phase column says. The ordinary path
	//     resumes that conversation instead of opening a second one. See
	//     recoverWorkspaceReadySpawn for why this matters.
	if !domain.SpawnPhaseTrackingEnabled(rec.Harness) || spawnCarriesConversationIdentity(rec) {
		return false, nil
	}
	phase := domain.NormalizeSpawnPhase(rec.SpawnPhase)
	if phase == domain.SpawnPhaseControllerReady {
		return false, nil
	}
	if phase == domain.SpawnPhasePreparing {
		if rec.Metadata.WorkspacePath == "" {
			// A seed row and nothing else. No worktree, no runtime, no provider
			// conversation was ever attributed to it, so removing it destroys
			// nothing a user could see. DeleteSession still refuses any row that
			// has progressed past seed state, so this cannot race a live spawn.
			m.logger.Info("reconcile: dropping seed row from an interrupted spawn", "sessionID", rec.ID)
			m.rollbackSpawnSeedRow(ctx, rec.ID)
			return true, nil
		}
		// A row migrated from a build without the phase column can be preparing
		// while already owning a workspace. Lift it so it takes the recovery
		// path rather than the seed-cleanup path; the store refuses to promote a
		// row with no workspace, so a true seed can never arrive here.
		promoted, err := m.store.PromoteSpawnPhaseWorkspaceReady(ctx, rec.ID, m.clock())
		if err != nil {
			return true, fmt.Errorf("reconcile %s: promote interrupted spawn: %w", rec.ID, err)
		}
		if !promoted {
			// Another actor advanced or terminated the row underneath us. Doing
			// nothing is the safe answer: the next pass reads the new truth.
			return true, nil
		}
		rec.SpawnPhase = domain.SpawnPhaseWorkspaceReady
	}
	_, err := m.recoverWorkspaceReadySpawn(ctx, "recover spawn", rec)
	return true, err
}

// spawnCarriesConversationIdentity reports whether the row names a conversation
// some controller already established — a provider conversation id, or a native
// agent session id.
//
// The process handles (runtime handle, launch id, controller generation) cannot
// answer this on their own: CommitSessionControllerEpoch clears all three
// together on a live session while an interface transition is in flight, which
// makes a mid-transition row look exactly like an abandoned seed. Fresh-starting
// one would abandon a real conversation and deliver its original prompt twice.
func spawnCarriesConversationIdentity(rec domain.SessionRecord) bool {
	return strings.TrimSpace(rec.Metadata.ProviderConversationID) != "" ||
		strings.TrimSpace(rec.Metadata.AgentSessionID) != ""
}

// recoverWorkspaceReadySpawn finishes a spawn whose workspace is durable but
// whose controller never was: reopen the worktree, reapply hooks and standing
// instructions, and start the selected provider fresh with the original prompt.
//
// Fresh is the only correct start here. The session has no committed provider
// conversation, so there is nothing to resume; and because the prompt was never
// delivered to any controller, replaying it now delivers it exactly once.
func (m *Manager) recoverWorkspaceReadySpawn(ctx context.Context, operation string, rec domain.SessionRecord) (RestoreResult, error) {
	// Fresh-launching a Chat session that has no provider conversation id is
	// safe only here, at workspace_ready, where no controller was ever
	// committed. Anywhere else an empty id means the id was lost, not that none
	// was ever minted, and starting fresh would silently abandon the user's
	// existing conversation. The ordinary resume path refuses that case with
	// ErrIncompleteHandle; this assertion keeps the two rules from drifting.
	if !domain.SpawnPhaseTrackingEnabled(rec.Harness) {
		return RestoreResult{}, fmt.Errorf("%s %s: %w: spawn recovery is not enabled for harness %q",
			operation, rec.ID, ErrIncompleteHandle, rec.Harness)
	}
	if phase := domain.NormalizeSpawnPhase(rec.SpawnPhase); phase != domain.SpawnPhaseWorkspaceReady {
		return RestoreResult{}, fmt.Errorf("%s %s: %w: spawn phase %s cannot be recovered by a fresh launch",
			operation, rec.ID, ErrIncompleteHandle, phase)
	}
	// The same rule stated over the durable facts rather than the phase column.
	// A row that names a conversation had a controller, whatever its phase says,
	// and fresh-starting it would abandon that conversation and redeliver the
	// original prompt. Refusing here means no caller — reconcile or Retry — can
	// reach a fresh launch over an existing conversation.
	if spawnCarriesConversationIdentity(rec) {
		return RestoreResult{}, fmt.Errorf(
			"%s %s: %w: an existing agent conversation cannot be restarted by a fresh launch",
			operation, rec.ID, ErrIncompleteHandle)
	}
	project, err := m.loadProject(ctx, rec.ProjectID)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("%s %s: %w", operation, rec.ID, err)
	}
	if project.Kind.WithDefault() == domain.ProjectKindScratch {
		// A scratch session has no branch to reopen and nothing to preserve.
		return RestoreResult{}, m.lcm.MarkTerminated(ctx, rec.ID)
	}
	ws, err := m.restoreSessionWorkspace(ctx, project, rec)
	if err != nil {
		return RestoreResult{}, m.preserveInterruptedSpawn(ctx, rec,
			fmt.Errorf("%s %s: reopen workspace: %w", operation, rec.ID, err))
	}
	// forceFresh=true reapplies hooks and standing instructions through the
	// ordinary prepare step and starts the provider without a resume handle.
	result, err := m.relaunchSessionWithPolicy(ctx, operation, rec, project, ws, nil, true, false)
	if err != nil {
		return RestoreResult{}, m.preserveInterruptedSpawn(ctx, rec, err)
	}
	if err := m.deliverRecoveredChatPrompt(ctx, rec); err != nil {
		return RestoreResult{}, m.preserveInterruptedSpawn(ctx, rec, err)
	}
	m.logger.Info("reconcile: finished an interrupted spawn from its workspace checkpoint",
		"sessionID", rec.ID, "workspacePath", ws.Path)
	if current, ok, getErr := m.store.GetSession(ctx, rec.ID); getErr == nil && ok {
		result.Session = current
	}
	return result, nil
}

// deliverRecoveredChatPrompt replays the checkpointed prompt into a freshly
// started Chat controller. The terminal path delivers the prompt as part of the
// launch itself; Chat has no such step, so a recovered Chat session would
// otherwise come up connected to a provider that was never asked to do
// anything. It runs only for a spawn that had not reached controller_ready, so
// the provider cannot already have received this prompt.
func (m *Manager) deliverRecoveredChatPrompt(ctx context.Context, rec domain.SessionRecord) error {
	if domain.NormalizeSessionMode(rec.Mode) != domain.SessionModeChat {
		return nil
	}
	prompt := rec.Metadata.Prompt
	if prompt == "" || m.chat == nil {
		return nil
	}
	if _, err := m.chat.StartChatTurn(ctx, rec.ID, prompt); err != nil {
		return fmt.Errorf("recover spawn %s: deliver original prompt: %w", rec.ID, err)
	}
	return nil
}

// preserveInterruptedSpawn records a failed recovery without destroying
// anything. The worktree stays, the checkpointed facts stay, and the spawn
// phase stays at workspace_ready so a later Retry takes this same fresh path
// rather than attempting a native resume that cannot exist. The controller is
// surfaced as exited so the UI can offer that retry.
func (m *Manager) preserveInterruptedSpawn(ctx context.Context, rec domain.SessionRecord, cause error) error {
	if errors.Is(cause, ports.ErrChatRecoveryInconclusive) {
		// An inconclusive Chat provider must not be replaced: a second controller
		// on the same conversation is worse than a stalled one.
		return fmt.Errorf("recover spawn %s: preserve detached Chat provider: %w", rec.ID, cause)
	}
	committed, err := m.preserveFailedReconcileRelaunch(ctx, rec)
	if err != nil {
		return fmt.Errorf("recover spawn %s: recovery failed and commit state became uncertain: %w",
			rec.ID, errors.Join(cause, err))
	}
	if committed {
		m.logger.Warn("reconcile: interrupted spawn reported an error after its controller committed; preserving the session",
			"sessionID", rec.ID, "error", cause)
		return nil
	}
	m.logger.Warn("reconcile: could not finish an interrupted spawn; workspace preserved for retry",
		"sessionID", rec.ID, "error", cause)
	// The cause is returned, not swallowed: the boot pass logs it, and a user
	// who pressed Retry needs to be told why it did not start.
	return cause
}
