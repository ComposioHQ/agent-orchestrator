package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
)

const codexProfileSwitchPoll = 150 * time.Millisecond

// StartCodexProfileSwitchConfig is one explicit confirmed assisted-switch request.
type StartCodexProfileSwitchConfig struct {
	TargetProfileID            string
	IdempotencyKey             string
	AcknowledgeUnknownCapacity bool
}

func (m *Manager) codexProfileSwitchStore() (ports.CodexProfileSwitchStore, error) {
	store, ok := m.store.(ports.CodexProfileSwitchStore)
	if !ok || m.codexProfileSwitchOptions == nil {
		return nil, ErrCodexProfileSwitchUnavailable
	}
	return store, nil
}

// CachedCodexProfileSwitchOptions performs no descriptor or native work.
func (m *Manager) CachedCodexProfileSwitchOptions(ctx context.Context, id domain.SessionID) (domain.CodexProfileSwitchOptions, error) {
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil {
		return domain.CodexProfileSwitchOptions{}, err
	}
	if !found {
		return domain.CodexProfileSwitchOptions{}, ErrNotFound
	}
	if rec.ArchivedAt != nil {
		return domain.CodexProfileSwitchOptions{}, ErrSessionArchived
	}
	if rec.Kind != domain.KindWorker || rec.Harness != domain.HarnessCodex || rec.CodexProfileBinding == nil {
		return domain.CodexProfileSwitchOptions{}, ErrCodexProfileSwitchRequiresCodex
	}
	if m.codexProfileSwitchOptions == nil {
		return domain.CodexProfileSwitchOptions{}, ErrCodexProfileSwitchUnavailable
	}
	return m.codexProfileSwitchOptions.CachedCodexProfileSwitchOptions(*rec.CodexProfileBinding), nil
}

// EnsureCodexProfileSwitchOptions refreshes display authentication/capacity.
func (m *Manager) EnsureCodexProfileSwitchOptions(ctx context.Context, id domain.SessionID) (domain.CodexProfileSwitchOptions, error) {
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil {
		return domain.CodexProfileSwitchOptions{}, err
	}
	if !found {
		return domain.CodexProfileSwitchOptions{}, ErrNotFound
	}
	if rec.ArchivedAt != nil {
		return domain.CodexProfileSwitchOptions{}, ErrSessionArchived
	}
	if rec.Kind != domain.KindWorker || rec.Harness != domain.HarnessCodex || rec.CodexProfileBinding == nil {
		return domain.CodexProfileSwitchOptions{}, ErrCodexProfileSwitchRequiresCodex
	}
	if m.codexProfileSwitchOptions == nil {
		return domain.CodexProfileSwitchOptions{}, ErrCodexProfileSwitchUnavailable
	}
	return m.codexProfileSwitchOptions.EnsureCodexProfileSwitchOptions(ctx, *rec.CodexProfileBinding)
}

// StartCodexProfileSwitch durably admits a switch and returns immediately.
func (m *Manager) StartCodexProfileSwitch(ctx context.Context, id domain.SessionID, cfg StartCodexProfileSwitchConfig) (domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	cfg.TargetProfileID = strings.TrimSpace(cfg.TargetProfileID)
	cfg.IdempotencyKey = strings.TrimSpace(cfg.IdempotencyKey)
	if cfg.IdempotencyKey == "" {
		return domain.CodexProfileSwitch{}, apierr.Invalid("IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required", nil)
	}
	fingerprint := domain.ComputeCodexProfileSwitchRequestFingerprint(id, cfg.TargetProfileID, cfg.AcknowledgeUnknownCapacity)
	if existing, found, lookupErr := store.GetCodexProfileSwitchByIdempotencyKey(ctx, id, cfg.IdempotencyKey); lookupErr != nil {
		return domain.CodexProfileSwitch{}, lookupErr
	} else if found {
		if existing.RequestFingerprint != fingerprint {
			return existing, domain.ErrCodexProfileSwitchIdempotencyConflict
		}
		return existing, nil
	}
	if err := m.beginAgentSwitchAttempt(); err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	attemptOwned := true
	defer func() {
		if attemptOwned {
			m.agentSwitchWorkers.Done()
		}
	}()
	if err := m.beginAgentOperation(ctx, id, agentOperationProfileSwitch); err != nil {
		if errors.Is(err, errAgentOperationInProgress) {
			return domain.CodexProfileSwitch{}, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "Another session operation is in progress", nil)
		}
		return domain.CodexProfileSwitch{}, err
	}
	gateOwned := true
	defer func() {
		if gateOwned {
			m.endAgentOperation(id, agentOperationProfileSwitch)
		}
	}()

	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	if !found {
		return domain.CodexProfileSwitch{}, ErrNotFound
	}
	if rec.ArchivedAt != nil {
		return domain.CodexProfileSwitch{}, ErrSessionArchived
	}
	if rec.IsTerminated || rec.Kind != domain.KindWorker || rec.Harness != domain.HarnessCodex || rec.CodexProfileBinding == nil {
		return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchRequiresCodex
	}
	if rec.CodexProfileBinding.ProfileID == cfg.TargetProfileID {
		return domain.CodexProfileSwitch{}, apierr.Conflict("CODEX_PROFILE_UNAVAILABLE", "The source profile cannot be its own continuation target", map[string]any{"profileId": cfg.TargetProfileID})
	}
	if mode := domain.NormalizeSessionMode(rec.Mode); mode == domain.SessionModeChat {
		if m.chat == nil || !m.chat.SupportsChat(domain.HarnessCodex) {
			return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchRequiresCodex
		}
	} else if strings.TrimSpace(rec.Metadata.RuntimeHandleID) == "" || strings.TrimSpace(rec.Metadata.RuntimeLaunchID) == "" {
		return domain.CodexProfileSwitch{}, ErrIncompleteHandle
	}

	options, err := m.codexProfileSwitchOptions.EnsureCodexProfileSwitchOptions(ctx, *rec.CodexProfileBinding)
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	var candidate *domain.CodexProfileSwitchCandidate
	for i := range options.Candidates {
		if options.Candidates[i].ID == cfg.TargetProfileID {
			candidate = &options.Candidates[i]
			break
		}
	}
	if candidate == nil {
		return domain.CodexProfileSwitch{}, apierr.NotFound("CODEX_PROFILE_NOT_FOUND", "Codex profile was not found")
	}
	if !candidate.Selectable {
		return domain.CodexProfileSwitch{}, candidateSelectionError(*candidate)
	}
	if candidate.RequiresCapacityAcknowledgement && !cfg.AcknowledgeUnknownCapacity {
		return domain.CodexProfileSwitch{}, apierr.Invalid("CODEX_PROFILE_SWITCH_CAPACITY_ACK_REQUIRED", "Acknowledge unknown or unsupported capacity to continue", map[string]any{"profileId": cfg.TargetProfileID})
	}
	if agentStore, ok := m.store.(ports.AgentSwitchStore); ok {
		if _, active, activeErr := agentStore.GetActiveAgentSwitch(ctx, id); activeErr != nil {
			return domain.CodexProfileSwitch{}, activeErr
		} else if active {
			return domain.CodexProfileSwitch{}, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "An agent switch is already in progress", nil)
		}
	}
	if transitionStore, ok := m.store.(interfaceTransitionStore); ok {
		if _, active, activeErr := transitionStore.GetActiveSessionInterfaceTransition(ctx, id); activeErr != nil {
			return domain.CodexProfileSwitch{}, activeErr
		} else if active {
			return domain.CodexProfileSwitch{}, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "An interface switch is already in progress", nil)
		}
	}

	now := m.clock()
	generation := domain.AgentGenerationID(rec.Metadata.RuntimeLaunchID)
	if domain.NormalizeSessionMode(rec.Mode) == domain.SessionModeChat {
		generation = domain.AgentGenerationID(rec.Metadata.ControllerGeneration)
	}
	trigger := m.codexProfileSwitchTrigger(id, options.SourceProfile.Capacity)
	sw := domain.CodexProfileSwitch{
		ID: domain.CodexProfileSwitchID("profile-switch-" + uuid.NewString()), SourceSessionID: id,
		SourceProfileID: rec.CodexProfileBinding.ProfileID, TargetProfileID: cfg.TargetProfileID,
		IdempotencyKey: cfg.IdempotencyKey, RequestFingerprint: fingerprint, Trigger: trigger,
		Phase: domain.CodexProfileSwitchRequested, WorkspaceOwner: domain.CodexProfileSwitchOwnerSource,
		SourceGenerationID: generation, SemanticHandoffStatus: domain.AgentHandoffNotAttempted,
		HandoffClassification:      domain.CodexProfileSwitchHandoffPending,
		AcknowledgeUnknownCapacity: cfg.AcknowledgeUnknownCapacity, RequestedAt: now, UpdatedAt: now,
		Initiator: domain.CodexProfileSwitchInitiatorManual,
	}
	stored, created, err := store.CreateCodexProfileSwitch(ctx, sw)
	if err != nil {
		return stored, err
	}
	if !created {
		return stored, nil
	}
	if trigger == domain.CodexProfileSwitchTriggerUsageLimitFailure {
		m.agentOpMu.Lock()
		delete(m.codexUsageLimited, id)
		m.agentOpMu.Unlock()
	}
	if err := m.startCodexProfileSwitchWorker(store, stored); err != nil {
		return stored, err
	}
	attemptOwned = false
	gateOwned = false
	return stored, nil
}

func candidateSelectionError(candidate domain.CodexProfileSwitchCandidate) error {
	switch candidate.ReasonCode {
	case domain.CodexProfileSwitchReasonAuthenticationRequired:
		return apierr.Conflict("CODEX_PROFILE_UNAUTHORIZED", "The selected Codex profile needs sign-in", map[string]any{"profileId": candidate.ID})
	case domain.CodexProfileSwitchReasonCapacityExhausted:
		return apierr.Conflict("CODEX_PROFILE_EXHAUSTED", "The selected Codex profile is exhausted", map[string]any{"profileId": candidate.ID})
	case domain.CodexProfileSwitchReasonAuthenticationUnverified:
		return apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "The selected Codex profile could not be verified", map[string]any{"profileId": candidate.ID})
	default:
		return apierr.Conflict("CODEX_PROFILE_UNAVAILABLE", "The selected Codex profile is unavailable", map[string]any{"profileId": candidate.ID})
	}
}

func (m *Manager) verifyCodexProfileSwitchTarget(ctx context.Context, sw domain.CodexProfileSwitch) (domain.CodexProfileSwitchVerification, error) {
	if sw.Initiator == domain.CodexProfileSwitchInitiatorAutomatic {
		if m.codexAutomaticProfiles == nil {
			return domain.CodexProfileSwitchVerification{}, ErrCodexAutomaticProfileSwitchUnavailable
		}
		verification, _, err := m.codexAutomaticProfiles.VerifyCodexAutomaticProfileSwitchCandidate(ctx, sw.TargetProfileID)
		return verification, err
	}
	return m.codexProfileSwitchOptions.VerifyCodexProfileSwitchTarget(ctx, sw.TargetProfileID, sw.AcknowledgeUnknownCapacity)
}

func (m *Manager) codexProfileSwitchTrigger(sessionID domain.SessionID, capacity *domain.CodexCapacitySummary) domain.CodexProfileSwitchTrigger {
	m.agentOpMu.Lock()
	_, usageLimited := m.codexUsageLimited[sessionID]
	m.agentOpMu.Unlock()
	if usageLimited {
		return domain.CodexProfileSwitchTriggerUsageLimitFailure
	}
	if capacity != nil && capacity.Freshness == domain.AgentReadinessFresh {
		switch capacity.State {
		case domain.CodexCapacityExhausted:
			return domain.CodexProfileSwitchTriggerExhausted
		case domain.CodexCapacityNearLimit:
			return domain.CodexProfileSwitchTriggerNearLimit
		}
	}
	return domain.CodexProfileSwitchTriggerManual
}

// ReportCodexUsageLimitFailure records a trusted structured Chat signal. For a
// source it only changes the trigger of a later explicitly-confirmed switch. For
// a continuation target it enters recovery and restores the exact predecessor;
// it never cascades to another profile.
func (m *Manager) ReportCodexUsageLimitFailure(ctx context.Context, sessionID domain.SessionID) {
	rec, found, _ := m.store.GetSession(ctx, sessionID)
	evidence := domain.CodexExhaustionEvidence{
		SessionID: sessionID, Trigger: domain.CodexAutomaticProfileSwitchUsageLimitFailure,
		EpisodeID: "usage-limit:" + m.clock().Format(time.RFC3339Nano), ObservedAt: m.clock(), Fresh: true,
	}
	if found && rec.CodexProfileBinding != nil {
		evidence.ProfileID = rec.CodexProfileBinding.ProfileID
		evidence.Generation = codexSessionGeneration(rec)
	}
	m.ReportCodexUsageLimitFailureEvidence(ctx, evidence)
}

// ReportCodexUsageLimitFailureEvidence preserves Phase 5 target recovery and
// otherwise offers the exact settled Chat episode to the Phase 6 coordinator.
func (m *Manager) ReportCodexUsageLimitFailureEvidence(ctx context.Context, evidence domain.CodexExhaustionEvidence) {
	sessionID := evidence.SessionID
	m.agentOpMu.Lock()
	m.codexUsageLimited[sessionID] = m.clock()
	m.agentOpMu.Unlock()

	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return
	}
	sw, found, err := store.GetCodexProfileSwitchForSession(context.WithoutCancel(ctx), sessionID)
	if err != nil || !found || sw.TargetSessionID == nil || *sw.TargetSessionID != sessionID || sw.Phase.Terminal() || sw.Phase == domain.CodexProfileSwitchRecoveryRequired {
		_, _, _ = m.ReportCodexExhaustion(context.WithoutCancel(ctx), evidence)
		return
	}
	go m.recoverCodexProfileSwitchTargetUsageLimit(store, sw)
}

func (m *Manager) recoverCodexProfileSwitchTargetUsageLimit(store ports.CodexProfileSwitchStore, sw domain.CodexProfileSwitch) {
	ctx, cancel := context.WithTimeout(m.backgroundContext, m.switchPostStopWait)
	defer cancel()
	current, found, err := store.GetCodexProfileSwitch(ctx, sw.ID)
	if err != nil || !found || current.Phase.Terminal() || current.Phase == domain.CodexProfileSwitchRecoveryRequired {
		return
	}
	next := current
	origin := current.Phase
	next.RecoveryOriginPhase = &origin
	next.Phase = domain.CodexProfileSwitchRecoveryRequired
	next.WorkspaceOwner = domain.CodexProfileSwitchOwnerRecovery
	next.ErrorCode = domain.CodexProfileSwitchErrorTargetUsageLimited
	next.UpdatedAt = m.clock()
	changed, err := store.UpdateCodexProfileSwitch(ctx, next, current.Phase, current.SourceGenerationID, current.TargetGenerationID)
	if err != nil || !changed {
		return
	}
	if _, err := m.RestoreCodexProfileSwitchSource(ctx, next.SourceSessionID, next.ID); err != nil {
		m.logger.Error("Codex profile switch target usage-limit recovery failed", "switchID", next.ID, "sourceSessionID", next.SourceSessionID, "targetSessionID", next.TargetSessionID, "error", err)
	}
}

func (m *Manager) startCodexProfileSwitchWorker(store ports.CodexProfileSwitchStore, sw domain.CodexProfileSwitch) error {
	m.agentSwitchWorkerMu.Lock()
	if m.agentSwitchWorkersClosed {
		m.agentSwitchWorkerMu.Unlock()
		return ErrSwitchShuttingDown
	}
	m.agentSwitchWorkerMu.Unlock()
	go func() {
		defer m.agentSwitchWorkers.Done()
		result, err := m.executeCodexProfileSwitch(m.backgroundContext, store, sw)
		if err != nil {
			m.logger.Error("Codex profile switch stopped", "switchID", result.ID, "sourceSessionID", result.SourceSessionID, "targetSessionID", result.TargetSessionID, "phase", result.Phase, "errorCode", result.ErrorCode, "error", err)
			return
		}
		m.logger.Info("Codex profile switch completed", "switchID", result.ID, "sourceSessionID", result.SourceSessionID, "targetSessionID", result.TargetSessionID)
	}()
	return nil
}

func (m *Manager) executeCodexProfileSwitch(ctx context.Context, store ports.CodexProfileSwitchStore, sw domain.CodexProfileSwitch) (result domain.CodexProfileSwitch, retErr error) {
	result = sw
	sourceID := sw.SourceSessionID
	defer func() {
		if result.TargetSessionID != nil {
			m.endAgentOperation(*result.TargetSessionID, agentOperationProfileSwitch)
		}
		if retErr == nil && result.Phase.Terminal() {
			m.endAgentOperation(sourceID, agentOperationProfileSwitch)
			return
		}
		if retErr == nil {
			return
		}
		latest, found, loadErr := store.GetCodexProfileSwitch(context.WithoutCancel(ctx), result.ID)
		if loadErr == nil && found {
			result = latest
		}
		if result.Phase.Terminal() {
			m.endAgentOperation(sourceID, agentOperationProfileSwitch)
			return
		}
		settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		next := result
		if result.Phase.Cancellable() {
			next.Phase = domain.CodexProfileSwitchFailed
			next.ErrorCode = domain.CodexProfileSwitchErrorFailed
			next.WorkspaceOwner = domain.CodexProfileSwitchOwnerSource
		} else {
			origin := result.Phase
			next.Phase = domain.CodexProfileSwitchRecoveryRequired
			next.RecoveryOriginPhase = &origin
			next.WorkspaceOwner = domain.CodexProfileSwitchOwnerRecovery
			if next.ErrorCode == "" {
				next.ErrorCode = phaseCodexProfileSwitchError(result.Phase)
			}
		}
		next.UpdatedAt = m.clock()
		if changed, updateErr := store.UpdateCodexProfileSwitch(settleCtx, next, result.Phase, result.SourceGenerationID, result.TargetGenerationID); updateErr == nil && changed {
			result = next
		}
		if result.Phase == domain.CodexProfileSwitchFailed {
			m.endAgentOperation(sourceID, agentOperationProfileSwitch)
		}
	}()

	source, found, err := m.store.GetSession(ctx, sourceID)
	if err != nil || !found {
		if err == nil {
			err = ErrNotFound
		}
		return result, err
	}
	if source.ArchivedAt != nil && result.Phase != domain.CodexProfileSwitchCompleted {
		return result, ErrSessionArchived
	}

	if result.Phase == domain.CodexProfileSwitchRequested {
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchWaitingForSafeBoundary, nil); err != nil {
			return result, err
		}
	}
	if result.Phase == domain.CodexProfileSwitchWaitingForSafeBoundary {
		if err := m.waitForCodexProfileSwitchBoundary(ctx, store, result, source); err != nil {
			return result, err
		}
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchPreparingHandoff, nil); err != nil {
			return result, err
		}
	}
	if result.Phase == domain.CodexProfileSwitchPreparingHandoff {
		if result.SemanticHandoffStatus == domain.AgentHandoffNotAttempted || result.SemanticHandoffStatus == domain.AgentHandoffRequested {
			if err := m.collectOptionalCodexProfileSwitchHandoff(ctx, store, &result, source); err != nil {
				m.logger.Warn("Codex profile switch semantic handoff unavailable; using deterministic context", "switchID", result.ID, "sourceSessionID", result.SourceSessionID, "error", err)
			}
		}
		if result.Phase.Terminal() {
			return result, nil
		}
		// A semantic handoff is itself a source turn. Re-prove the safe boundary
		// after it settles so stopping_source is never persisted while that exact
		// generation is still producing output or awaiting input.
		if err := m.waitForCodexProfileSwitchBoundary(ctx, store, result, source); err != nil {
			return result, err
		}
		verification, err := m.verifyCodexProfileSwitchTarget(ctx, result)
		if err != nil {
			return result, err
		}
		if verification.LaunchContext.Binding.ProfileID != result.TargetProfileID {
			return result, errors.New("verified profile identity changed")
		}
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchStoppingSource, nil); err != nil {
			return result, err
		}
	}

	terminalTail := ""
	if result.Phase == domain.CodexProfileSwitchStoppingSource {
		if domain.NormalizeSessionMode(source.Mode) == domain.SessionModeTUI && strings.TrimSpace(source.Metadata.RuntimeHandleID) != "" {
			if output, outputErr := m.runtime.GetOutput(ctx, ports.RuntimeHandle{ID: source.Metadata.RuntimeHandleID}, handoffTerminalMaxLines); outputErr == nil {
				terminalTail = output
			}
		}
		if err := m.stopCodexProfileSwitchSource(ctx, source); err != nil {
			result.ErrorCode = domain.CodexProfileSwitchErrorSourceStopUnconfirmed
			return result, err
		}
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchSourceStopped, func(next *domain.CodexProfileSwitch) {
			next.WorkspaceOwner = domain.CodexProfileSwitchOwnerSwitch
		}); err != nil {
			return result, err
		}
	}

	project, err := m.loadProject(ctx, source.ProjectID)
	if err != nil {
		return result, err
	}
	var target domain.SessionRecord
	if result.Phase == domain.CodexProfileSwitchSourceStopped {
		verification, err := m.verifyCodexProfileSwitchTarget(ctx, result)
		if err != nil {
			return result, err
		}
		seed := codexProfileContinuationSeed(source, m.clock())
		binding := verification.LaunchContext.Binding
		target, result, err = store.CreateCodexProfileSwitchTarget(ctx, result, seed, binding, m.clock())
		if err != nil {
			return result, err
		}
		if err := m.beginAgentOperation(ctx, target.ID, agentOperationProfileSwitch); err != nil {
			return result, err
		}
	}
	if result.TargetSessionID == nil {
		return result, errors.New("profile switch target was not allocated")
	}
	if target.ID == "" {
		target, found, err = m.store.GetSession(ctx, *result.TargetSessionID)
		if err != nil || !found {
			if err == nil {
				err = ErrNotFound
			}
			return result, err
		}
		if !m.SessionMutationInProgress(target.ID) {
			if err := m.beginAgentOperation(ctx, target.ID, agentOperationProfileSwitch); err != nil {
				return result, err
			}
		}
	}
	if result.Phase == domain.CodexProfileSwitchStartingTarget && result.FinalHandoffPath == "" {
		written, err := m.writeCodexProfileSwitchHandoff(ctx, result, source, target.ID, terminalTail)
		if err != nil {
			return result, err
		}
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, result.Phase, func(next *domain.CodexProfileSwitch) {
			next.FinalHandoffPath, next.FinalHandoffHash = written.Path, written.Hash
			if next.SemanticHandoffStatus == domain.AgentHandoffReceived {
				next.HandoffClassification = domain.CodexProfileSwitchHandoffSemantic
			} else {
				next.HandoffClassification = domain.CodexProfileSwitchHandoffFallback
			}
		}); err != nil {
			return result, err
		}
		if cleanupErr := m.removeTemporaryAgentHandoff(ctx, result.SourceSessionID, string(result.ID)); cleanupErr != nil {
			m.logger.Warn("Codex profile switch temporary handoff cleanup failed", "switchID", result.ID, "sourceSessionID", result.SourceSessionID, "error", cleanupErr)
		}
	}
	if result.Phase == domain.CodexProfileSwitchStartingTarget {
		live, targetGeneration, liveErr := m.codexProfileSwitchTargetLive(ctx, result, target)
		if liveErr != nil {
			result.ErrorCode = domain.CodexProfileSwitchErrorTargetStartUnconfirmed
			return result, liveErr
		}
		if !live {
			ws := ports.WorkspaceInfo{Path: target.Metadata.WorkspacePath, RepoPath: target.Metadata.WorkspaceRepoPath, Branch: target.Metadata.Branch, SessionID: target.ID, ProjectID: target.ProjectID}
			restore, err := m.relaunchSessionWithPolicy(ctx, "Codex profile continuation", target, project, ws, nil, true, false)
			if err != nil {
				result.ErrorCode = domain.CodexProfileSwitchErrorTargetStartUnconfirmed
				return result, err
			}
			target = restore.Session
			targetGeneration = domain.AgentGenerationID(target.Metadata.RuntimeLaunchID)
			if domain.NormalizeSessionMode(target.Mode) == domain.SessionModeChat {
				targetGeneration = domain.AgentGenerationID(target.Metadata.ControllerGeneration)
			}
			if targetGeneration == "" {
				return result, errors.New("target generation was not recorded")
			}
		}
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchTargetReady, func(next *domain.CodexProfileSwitch) {
			next.TargetGenerationID = targetGeneration
			next.TargetRuntimeHandleID = target.Metadata.RuntimeHandleID
			next.TargetControllerGeneration = target.Metadata.ControllerGeneration
			next.TargetProviderThreadID = target.Metadata.ProviderConversationID
		}); err != nil {
			return result, err
		}
	}
	if result.Phase == domain.CodexProfileSwitchTargetReady {
		if err := m.advanceCodexProfileSwitch(ctx, store, &result, domain.CodexProfileSwitchDeliveringHandoff, nil); err != nil {
			return result, err
		}
	}
	if result.Phase == domain.CodexProfileSwitchDeliveringHandoff && result.TargetAcknowledgedAt == nil {
		if domain.NormalizeSessionMode(target.Mode) == domain.SessionModeChat {
			if _, err := m.chat.RelayChatTurnWithID(ctx, target.ID, aoCodexProfileTargetActivationPrompt, "profile-switch:"+string(result.ID)+":activation"); err != nil {
				return result, err
			}
			ackAt := m.clock()
			changed, err := store.AcknowledgeCodexProfileSwitchTarget(ctx, result.ID, target.ID, result.TargetGenerationID, ackAt)
			if err != nil || !changed {
				return result, errors.Join(err, errors.New("target acknowledgement changed concurrently"))
			}
		} else {
			outcome, err := m.messenger.DeliverUnderMutation(ctx, target.ID, aoCodexProfileTargetActivationPrompt)
			if err != nil || outcome != sessionguard.Sent {
				return result, errors.Join(err, fmt.Errorf("target activation delivery was %s", outcome.String()))
			}
		}
		acknowledged, err := m.waitForCodexProfileSwitchAcknowledgement(ctx, store, result)
		if err != nil {
			return result, err
		}
		result = acknowledged
	}
	completed, changed, err := store.CompleteCodexProfileSwitch(ctx, result, *result.TargetAcknowledgedAt)
	if err != nil || !changed {
		return result, errors.Join(err, errors.New("profile switch completion changed concurrently"))
	}
	result = completed
	return result, nil
}

func (m *Manager) codexProfileSwitchTargetLive(ctx context.Context, sw domain.CodexProfileSwitch, target domain.SessionRecord) (bool, domain.AgentGenerationID, error) {
	if domain.NormalizeSessionMode(target.Mode) == domain.SessionModeChat {
		if m.chat == nil || !m.chat.HasLiveChatController(target.ID) {
			return false, "", nil
		}
		generation := domain.AgentGenerationID(target.Metadata.ControllerGeneration)
		if generation == "" || (sw.TargetGenerationID != "" && sw.TargetGenerationID != generation) ||
			(sw.TargetControllerGeneration != "" && sw.TargetControllerGeneration != target.Metadata.ControllerGeneration) ||
			(sw.TargetProviderThreadID != "" && sw.TargetProviderThreadID != target.Metadata.ProviderConversationID) {
			return false, "", apierr.Unavailable("CODEX_PROFILE_SWITCH_TARGET_START_UNCONFIRMED", "The live continuation controller does not match the durable target")
		}
		return true, generation, nil
	}
	if strings.TrimSpace(target.Metadata.RuntimeHandleID) == "" {
		return false, "", nil
	}
	alive, err := m.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: target.Metadata.RuntimeHandleID})
	if err != nil {
		return false, "", apierr.Unavailable("CODEX_PROFILE_SWITCH_TARGET_START_UNCONFIRMED", "The continuation runtime state could not be verified")
	}
	if !alive {
		return false, "", nil
	}
	generation := domain.AgentGenerationID(target.Metadata.RuntimeLaunchID)
	if generation == "" || (sw.TargetGenerationID != "" && sw.TargetGenerationID != generation) ||
		(sw.TargetRuntimeHandleID != "" && sw.TargetRuntimeHandleID != target.Metadata.RuntimeHandleID) {
		return false, "", apierr.Unavailable("CODEX_PROFILE_SWITCH_TARGET_START_UNCONFIRMED", "The live continuation runtime does not match the durable target")
	}
	return true, generation, nil
}

func codexProfileContinuationSeed(source domain.SessionRecord, now time.Time) domain.SessionRecord {
	seed := source
	seed.ID = ""
	seed.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	seed.FirstSignalAt = time.Time{}
	seed.IsTerminated = false
	seed.IsPinned, seed.PinnedAt, seed.ArchivedAt = false, nil, nil
	seed.CleanupGeneration = 0
	seed.CreatedAt, seed.UpdatedAt = now, now
	seed.Metadata.RuntimeHandleID = ""
	seed.Metadata.RuntimeLaunchID = ""
	seed.Metadata.AgentSessionID = ""
	seed.Metadata.AgentSessionIDLaunchID = ""
	seed.Metadata.NativeTranscriptPath = ""
	seed.Metadata.ProviderConversationID = ""
	seed.Metadata.ControllerGeneration = ""
	seed.Metadata.BrowserCapabilityVerifier = ""
	seed.Metadata.PreviewURL = ""
	seed.Metadata.PreviewRevision = 0
	seed.CodexProfileBinding = nil
	return seed
}

func (m *Manager) waitForCodexProfileSwitchBoundary(ctx context.Context, store ports.CodexProfileSwitchStore, sw domain.CodexProfileSwitch, source domain.SessionRecord) error {
	ticker := time.NewTicker(codexProfileSwitchPoll)
	defer ticker.Stop()
	for {
		currentSwitch, found, err := store.GetCodexProfileSwitch(ctx, sw.ID)
		if err != nil || !found {
			if err == nil {
				err = ErrCodexProfileSwitchNotFound
			}
			return err
		}
		if currentSwitch.Phase == domain.CodexProfileSwitchCancelled {
			return context.Canceled
		}
		rec, found, err := m.store.GetSession(ctx, source.ID)
		if err != nil || !found {
			if err == nil {
				err = ErrNotFound
			}
			return err
		}
		if rec.ArchivedAt != nil || rec.IsTerminated {
			return ErrSessionArchived
		}
		if rec.Activity.State == domain.ActivityIdle || rec.Activity.State == domain.ActivityExited {
			if domain.NormalizeSessionMode(rec.Mode) == domain.SessionModeChat {
				if handoff, ok := m.chat.(chatHandoffLauncher); ok {
					if err := handoff.PrepareChatHandoff(ctx, rec.ID, domain.SessionInterfaceTransitionDrain); err != nil {
						return err
					}
				}
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (m *Manager) stopCodexProfileSwitchSource(ctx context.Context, source domain.SessionRecord) error {
	releaseShell, err := m.beginShellTerminalTeardown(ctx, source.ID)
	if err != nil {
		return err
	}
	if releaseShell != nil {
		defer releaseShell()
	}
	if err := m.terminateReviewer(ctx, source.ID, "Codex profile continuation stopped the predecessor reviewer."); err != nil {
		return err
	}
	if m.preview != nil {
		if err := m.preview.StopSession(ctx, source.ID); err != nil {
			return err
		}
	}
	if m.browser != nil {
		if err := m.browser.DestroySession(ctx, source.ID); err != nil {
			return err
		}
	}
	if domain.NormalizeSessionMode(source.Mode) == domain.SessionModeChat {
		if m.chat == nil {
			return ports.ErrChatUnsupported
		}
		if err := m.chat.StopChat(ctx, source.ID); err != nil {
			return err
		}
		if m.chat.HasLiveChatController(source.ID) {
			return errors.New("source Chat controller still exists")
		}
		return nil
	}
	_, releaseInput := m.beginTerminalInputDrain(source)
	if releaseInput != nil {
		defer releaseInput()
	}
	handle := ports.RuntimeHandle{ID: source.Metadata.RuntimeHandleID}
	alive, err := m.runtime.IsAlive(ctx, handle)
	if err == nil && !alive {
		return nil
	}
	return m.stopSourceRuntime(ctx, handle)
}

func (m *Manager) advanceCodexProfileSwitch(ctx context.Context, store ports.CodexProfileSwitchStore, sw *domain.CodexProfileSwitch, nextPhase domain.CodexProfileSwitchPhase, mutate func(*domain.CodexProfileSwitch)) error {
	previousPhase, previousTargetGeneration := sw.Phase, sw.TargetGenerationID
	next := *sw
	next.Phase = nextPhase
	if mutate != nil {
		mutate(&next)
	}
	next.UpdatedAt = m.clock()
	changed, err := store.UpdateCodexProfileSwitch(ctx, next, previousPhase, sw.SourceGenerationID, previousTargetGeneration)
	if err != nil {
		return err
	}
	if !changed {
		return domain.ErrCodexProfileSwitchTransitionConflict
	}
	*sw = next
	return nil
}

func (m *Manager) waitForCodexProfileSwitchAcknowledgement(ctx context.Context, store ports.CodexProfileSwitchStore, sw domain.CodexProfileSwitch) (domain.CodexProfileSwitch, error) {
	wait := m.switchDeliveryAckWait
	if wait <= 0 {
		wait = 150 * time.Second
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	ticker := time.NewTicker(codexProfileSwitchPoll)
	defer ticker.Stop()
	for {
		current, found, err := store.GetCodexProfileSwitch(ctx, sw.ID)
		if err != nil || !found {
			if err == nil {
				err = ErrCodexProfileSwitchNotFound
			}
			return sw, err
		}
		if current.TargetAcknowledgedAt != nil {
			return current, nil
		}
		select {
		case <-ctx.Done():
			return current, ctx.Err()
		case <-timer.C:
			return current, apierr.Unavailable("CODEX_PROFILE_SWITCH_DELIVERY_UNCONFIRMED", "The continuation delivery could not be confirmed")
		case <-ticker.C:
		}
	}
}

func phaseCodexProfileSwitchError(phase domain.CodexProfileSwitchPhase) domain.CodexProfileSwitchErrorCode {
	switch phase {
	case domain.CodexProfileSwitchStoppingSource:
		return domain.CodexProfileSwitchErrorSourceStopUnconfirmed
	case domain.CodexProfileSwitchStartingTarget:
		return domain.CodexProfileSwitchErrorTargetStartUnconfirmed
	case domain.CodexProfileSwitchTargetReady, domain.CodexProfileSwitchDeliveringHandoff:
		return domain.CodexProfileSwitchErrorDeliveryUnconfirmed
	default:
		return domain.CodexProfileSwitchErrorWorkspaceRecoveryRequired
	}
}

// CancelCodexProfileSwitch is safe only before stopping_source is durable.
func (m *Manager) CancelCodexProfileSwitch(ctx context.Context, sourceID domain.SessionID, switchID domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	sw, found, err := store.GetCodexProfileSwitch(ctx, switchID)
	if err != nil || !found || sw.SourceSessionID != sourceID {
		return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchNotFound
	}
	if !sw.Phase.Cancellable() {
		return sw, ErrCodexProfileSwitchCancellationUnsafe
	}
	next := sw
	next.Phase = domain.CodexProfileSwitchCancelled
	next.ErrorCode = domain.CodexProfileSwitchErrorRequestCancelled
	next.UpdatedAt = m.clock()
	changed, err := store.UpdateCodexProfileSwitch(ctx, next, sw.Phase, sw.SourceGenerationID, sw.TargetGenerationID)
	if err != nil || !changed {
		return sw, errors.Join(err, ErrCodexProfileSwitchCancellationUnsafe)
	}
	m.endAgentOperation(sourceID, agentOperationProfileSwitch)
	return next, nil
}

// ListCodexProfileSwitches returns source-owned operation history.
func (m *Manager) ListCodexProfileSwitches(ctx context.Context, sourceID domain.SessionID) ([]domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return nil, err
	}
	if _, found, err := m.store.GetSession(ctx, sourceID); err != nil {
		return nil, err
	} else if !found {
		return nil, ErrNotFound
	}
	return store.ListCodexProfileSwitches(ctx, sourceID)
}

// GetCodexProfileSwitch returns one source-scoped operation.
func (m *Manager) GetCodexProfileSwitch(ctx context.Context, sourceID domain.SessionID, switchID domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	sw, found, err := store.GetCodexProfileSwitch(ctx, switchID)
	if err != nil || !found || sw.SourceSessionID != sourceID {
		return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchNotFound
	}
	return sw, nil
}

// RecoverCodexProfileSwitch retries the existing target only.
func (m *Manager) RecoverCodexProfileSwitch(ctx context.Context, sourceID domain.SessionID, switchID domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	sw, found, err := store.GetCodexProfileSwitch(ctx, switchID)
	if err != nil || !found || sw.SourceSessionID != sourceID {
		return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchNotFound
	}
	if sw.Phase != domain.CodexProfileSwitchRecoveryRequired {
		return sw, ErrCodexProfileSwitchRecoveryRequired
	}
	origin := domain.CodexProfileSwitchSourceStopped
	if sw.RecoveryOriginPhase != nil {
		origin = *sw.RecoveryOriginPhase
	}
	if origin == domain.CodexProfileSwitchStoppingSource {
		origin = domain.CodexProfileSwitchStoppingSource
	} else if sw.TargetSessionID != nil {
		origin = domain.CodexProfileSwitchStartingTarget
	}
	next := sw
	next.Phase, next.WorkspaceOwner, next.ErrorCode, next.UpdatedAt = origin, domain.CodexProfileSwitchOwnerRecovery, "", m.clock()
	changed, err := store.UpdateCodexProfileSwitch(ctx, next, sw.Phase, sw.SourceGenerationID, sw.TargetGenerationID)
	if err != nil || !changed {
		return sw, errors.Join(err, domain.ErrCodexProfileSwitchTransitionConflict)
	}
	if err := m.beginAgentSwitchAttempt(); err != nil {
		return next, err
	}
	if err := m.startCodexProfileSwitchWorker(store, next); err != nil {
		m.agentSwitchWorkers.Done()
		return next, err
	}
	return next, nil
}

// RestoreCodexProfileSwitchSource stops only the exact target and restores the predecessor.
func (m *Manager) RestoreCodexProfileSwitchSource(ctx context.Context, sourceID domain.SessionID, switchID domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error) {
	store, err := m.codexProfileSwitchStore()
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	sw, found, err := store.GetCodexProfileSwitch(ctx, switchID)
	if err != nil || !found || sw.SourceSessionID != sourceID {
		return domain.CodexProfileSwitch{}, ErrCodexProfileSwitchNotFound
	}
	if sw.Phase != domain.CodexProfileSwitchRecoveryRequired {
		return sw, ErrCodexProfileSwitchRecoveryRequired
	}
	if sw.TargetSessionID != nil {
		target, targetFound, err := m.store.GetSession(ctx, *sw.TargetSessionID)
		if err != nil {
			return sw, err
		}
		if targetFound {
			if domain.NormalizeSessionMode(target.Mode) == domain.SessionModeChat {
				if m.chat != nil && m.chat.HasLiveChatController(target.ID) {
					if err := m.chat.StopChat(ctx, target.ID); err != nil {
						return sw, err
					}
				}
				if m.chat != nil && m.chat.HasLiveChatController(target.ID) {
					return sw, apierr.Unavailable("CODEX_PROFILE_SWITCH_TARGET_START_UNCONFIRMED", "The continuation target could not be stopped safely")
				}
			} else if target.Metadata.RuntimeHandleID != "" {
				handle := ports.RuntimeHandle{ID: target.Metadata.RuntimeHandleID}
				alive, probeErr := m.runtime.IsAlive(ctx, handle)
				if probeErr != nil {
					return sw, apierr.Unavailable("CODEX_PROFILE_SWITCH_TARGET_START_UNCONFIRMED", "The continuation target state could not be verified")
				}
				if alive {
					if err := m.stopSourceRuntime(ctx, handle); err != nil {
						return sw, err
					}
				}
			}
		}
	}
	sourceBeforeRestore, sourceFound, err := m.store.GetSession(ctx, sourceID)
	if err != nil || !sourceFound {
		return sw, errors.Join(err, apierr.Unavailable("CODEX_PROFILE_SWITCH_WORKSPACE_RECOVERY_REQUIRED", "The predecessor could not be verified"))
	}
	sourceStillRunning := false
	if domain.NormalizeSessionMode(sourceBeforeRestore.Mode) == domain.SessionModeChat {
		sourceStillRunning = m.chat != nil && m.chat.HasLiveChatController(sourceID)
	} else if sourceBeforeRestore.Metadata.RuntimeHandleID != "" {
		sourceStillRunning, err = m.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: sourceBeforeRestore.Metadata.RuntimeHandleID})
		if err != nil {
			return sw, apierr.Unavailable("CODEX_PROFILE_SWITCH_SOURCE_STOP_UNCONFIRMED", "The predecessor state could not be verified")
		}
	}
	restored, changed, err := store.RestoreCodexProfileSwitchSource(ctx, sw, m.clock())
	if err != nil || !changed {
		return sw, errors.Join(err, apierr.Unavailable("CODEX_PROFILE_SWITCH_WORKSPACE_RECOVERY_REQUIRED", "Workspace ownership could not be restored"))
	}
	source, sourceFound, err := m.store.GetSession(ctx, sourceID)
	if err != nil || !sourceFound {
		return restored, errors.Join(err, apierr.Unavailable("CODEX_PROFILE_SWITCH_WORKSPACE_RECOVERY_REQUIRED", "The predecessor could not be restored"))
	}
	if !sourceStillRunning {
		project, err := m.loadProject(ctx, source.ProjectID)
		if err != nil {
			return restored, err
		}
		ws := ports.WorkspaceInfo{Path: source.Metadata.WorkspacePath, RepoPath: source.Metadata.WorkspaceRepoPath, Branch: source.Metadata.Branch, SessionID: source.ID, ProjectID: source.ProjectID}
		if _, err := m.relaunchSessionWithPolicy(ctx, "Codex profile switch source restoration", source, project, ws, nil, false, false); err != nil {
			restored.ErrorCode = domain.CodexProfileSwitchErrorSourceRestoreUnconfirmed
			restored.UpdatedAt = m.clock()
			_, _ = store.UpdateCodexProfileSwitch(context.WithoutCancel(ctx), restored, restored.Phase, restored.SourceGenerationID, restored.TargetGenerationID)
			return restored, apierr.Unavailable("CODEX_PROFILE_SWITCH_WORKSPACE_RECOVERY_REQUIRED", "The predecessor could not be restarted safely")
		}
	}
	terminal := restored
	terminal.Phase = domain.CodexProfileSwitchFailed
	terminal.WorkspaceOwner = domain.CodexProfileSwitchOwnerSource
	terminal.ErrorCode = domain.CodexProfileSwitchErrorTargetUnavailable
	if sw.ErrorCode == domain.CodexProfileSwitchErrorTargetUsageLimited {
		terminal.ErrorCode = domain.CodexProfileSwitchErrorTargetUsageLimited
	}
	terminal.UpdatedAt = m.clock()
	if changed, updateErr := store.UpdateCodexProfileSwitch(ctx, terminal, restored.Phase, restored.SourceGenerationID, restored.TargetGenerationID); updateErr != nil || !changed {
		return restored, errors.Join(updateErr, apierr.Unavailable("CODEX_PROFILE_SWITCH_WORKSPACE_RECOVERY_REQUIRED", "The restored predecessor could not be finalized"))
	}
	restored = terminal
	m.endAgentOperation(sourceID, agentOperationProfileSwitch)
	if sw.TargetSessionID != nil {
		m.endAgentOperation(*sw.TargetSessionID, agentOperationProfileSwitch)
	}
	return restored, nil
}

// ReconcileCodexProfileSwitches reacquires every durable source gate before mutations.
func (m *Manager) ReconcileCodexProfileSwitches(ctx context.Context) error {
	store, err := m.codexProfileSwitchStore()
	if errors.Is(err, ErrCodexProfileSwitchUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	switches, err := store.ListActiveCodexProfileSwitches(ctx)
	if err != nil {
		return err
	}
	for _, sw := range switches {
		if err := m.beginAgentOperation(ctx, sw.SourceSessionID, agentOperationProfileSwitch); err != nil && !errors.Is(err, errAgentOperationInProgress) {
			return err
		}
		if sw.TargetSessionID != nil {
			_ = m.beginAgentOperation(ctx, *sw.TargetSessionID, agentOperationProfileSwitch)
		}
		if sw.Phase == domain.CodexProfileSwitchRecoveryRequired {
			continue
		}
		if err := m.beginAgentSwitchAttempt(); err != nil {
			return err
		}
		if err := m.startCodexProfileSwitchWorker(store, sw); err != nil {
			m.agentSwitchWorkers.Done()
			return err
		}
	}
	return nil
}
