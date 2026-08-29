package sessionmanager

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// PutCodexAutomaticProfileSwitchPolicyConfig is the authoritative ordered
// allowlist update guarded by a monotonic revision.
type PutCodexAutomaticProfileSwitchPolicyConfig struct {
	Enabled          bool
	ProfileIDs       []string
	ExpectedRevision int64
}

func (m *Manager) codexAutomaticStore() (ports.CodexAutomaticProfileSwitchStore, error) {
	store, ok := m.store.(ports.CodexAutomaticProfileSwitchStore)
	if !ok || m.codexAutomaticProfiles == nil {
		return nil, ErrCodexAutomaticProfileSwitchUnavailable
	}
	return store, nil
}

func (m *Manager) codexAutomaticSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, error) {
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	if !found {
		return domain.SessionRecord{}, ErrNotFound
	}
	if rec.ArchivedAt != nil {
		return domain.SessionRecord{}, ErrSessionArchived
	}
	if rec.Kind != domain.KindWorker || rec.Harness != domain.HarnessCodex || rec.CodexProfileBinding == nil {
		return domain.SessionRecord{}, ErrCodexAutomaticProfileSwitchRequiresCodex
	}
	return rec, nil
}

// CachedCodexAutomaticProfileSwitchPolicy performs no descriptor or native
// work and does not create a missing disabled policy.
func (m *Manager) CachedCodexAutomaticProfileSwitchPolicy(ctx context.Context, id domain.SessionID) (domain.CodexAutomaticProfileSwitchPolicy, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	rec, err := m.codexAutomaticSession(ctx, id)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	policy, _, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, id)
	if err != nil {
		return policy, err
	}
	return m.decorateAutomaticPolicy(policy, *rec.CodexProfileBinding), nil
}

// PutCodexAutomaticProfileSwitchPolicy validates identifiers without native
// account work, then performs one durable compare-and-swap update.
func (m *Manager) PutCodexAutomaticProfileSwitchPolicy(ctx context.Context, id domain.SessionID, cfg PutCodexAutomaticProfileSwitchPolicyConfig) (domain.CodexAutomaticProfileSwitchPolicy, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	rec, err := m.codexAutomaticSession(ctx, id)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	ids := make([]string, 0, len(cfg.ProfileIDs))
	seen := make(map[string]struct{}, len(cfg.ProfileIDs))
	for _, raw := range cfg.ProfileIDs {
		profileID := strings.TrimSpace(raw)
		if profileID == "" {
			return domain.CodexAutomaticProfileSwitchPolicy{}, apierr.Invalid("INVALID_CODEX_AUTOMATIC_PROFILE_SWITCH_POLICY", "Profile IDs must not be empty", nil)
		}
		if _, duplicate := seen[profileID]; duplicate {
			return domain.CodexAutomaticProfileSwitchPolicy{}, apierr.Invalid("DUPLICATE_CODEX_PROFILE_ID", "The profile list contains a duplicate ID", map[string]any{"profileId": profileID})
		}
		seen[profileID] = struct{}{}
		ids = append(ids, profileID)
	}
	if cfg.Enabled && len(ids) == 0 {
		return domain.CodexAutomaticProfileSwitchPolicy{}, apierr.Invalid("INVALID_CODEX_AUTOMATIC_PROFILE_SWITCH_POLICY", "Enabled automatic switching requires at least one profile", nil)
	}
	current, found, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, id)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	if (!found && cfg.ExpectedRevision != 0) || (found && current.Revision != cfg.ExpectedRevision) {
		return domain.CodexAutomaticProfileSwitchPolicy{}, apierr.Conflict("CODEX_AUTOMATIC_PROFILE_SWITCH_POLICY_REVISION_CONFLICT", "The automatic profile-switch policy changed", map[string]any{"currentRevision": current.Revision})
	}
	if err := m.codexAutomaticProfiles.ValidateCodexAutomaticProfileSwitchPolicyProfiles(ctx, current.ProfileIDs, ids); err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	policy, err := store.PutCodexAutomaticProfileSwitchPolicy(ctx, id, cfg.Enabled, ids, cfg.ExpectedRevision, m.clock())
	if errors.Is(err, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict) {
		return domain.CodexAutomaticProfileSwitchPolicy{}, apierr.Conflict("CODEX_AUTOMATIC_PROFILE_SWITCH_POLICY_REVISION_CONFLICT", "The automatic profile-switch policy changed", nil)
	}
	if err != nil {
		return policy, err
	}
	policy = m.decorateAutomaticPolicy(policy, *rec.CodexProfileBinding)
	if !cfg.Enabled {
		if attempt, active, _ := store.GetActiveCodexAutomaticProfileSwitchAttempt(context.WithoutCancel(ctx), id); active && attempt.State == domain.CodexAutomaticProfileSwitchEvaluating {
			_, _ = m.cancelCodexAutomaticAttempt(context.WithoutCancel(ctx), store, attempt)
		}
	}
	return policy, nil
}

func (m *Manager) decorateAutomaticPolicy(policy domain.CodexAutomaticProfileSwitchPolicy, binding domain.CodexSessionBinding) domain.CodexAutomaticProfileSwitchPolicy {
	policy.CurrentProfile = m.codexProfileSwitchOptions.CachedCodexProfileSwitchOptions(binding).SourceProfile
	policy.Profiles = m.codexAutomaticProfiles.CachedCodexAutomaticProfileSwitchPolicyEntries(binding.ProfileID, policy.ProfileIDs)
	return policy
}

// ReportCodexExhaustion admits or joins one daemon-owned evaluation. Callers
// must provide structured, bound evidence; terminal output is never accepted.
func (m *Manager) ReportCodexExhaustion(ctx context.Context, evidence domain.CodexExhaustionEvidence) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		if errors.Is(err, ErrCodexAutomaticProfileSwitchUnavailable) {
			return domain.CodexAutomaticProfileSwitchAttempt{}, false, nil
		}
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
	}
	if !evidence.Trigger.Valid() || strings.TrimSpace(evidence.ProfileID) == "" || strings.TrimSpace(evidence.EpisodeID) == "" || evidence.Generation == "" {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, apierr.Invalid("INVALID_CODEX_AUTOMATIC_PROFILE_SWITCH_POLICY", "Invalid structured exhaustion evidence", nil)
	}
	rec, err := m.codexAutomaticSession(ctx, evidence.SessionID)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
	}
	if rec.CodexProfileBinding.ProfileID != evidence.ProfileID || codexSessionGeneration(rec) != evidence.Generation {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, apierr.Conflict("CODEX_AUTOMATIC_PROFILE_SWITCH_SOURCE_UNVERIFIED", "Exhaustion evidence does not match the current bound session", nil)
	}
	policy, found, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, evidence.SessionID)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
	}
	if !found || !policy.Enabled {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, nil
	}
	now := m.clock()
	attempt := domain.CodexAutomaticProfileSwitchAttempt{
		ID: "automatic-profile-switch-" + uuid.NewString(), ChainRootSessionID: policy.ChainRootSessionID,
		SourceSessionID: evidence.SessionID, SourceProfileID: evidence.ProfileID,
		SourceGenerationID: evidence.Generation, SourceEpisodeID: strings.TrimSpace(evidence.EpisodeID),
		Trigger: evidence.Trigger, ExhaustionFingerprint: domain.CodexAutomaticProfileSwitchFingerprint(evidence),
		PolicyRevision: policy.Revision, State: domain.CodexAutomaticProfileSwitchEvaluating,
		OutcomeCode: domain.CodexAutomaticSwitchOutcomeEvaluating, Candidates: []domain.CodexAutomaticProfileSwitchAttemptCandidate{},
		Reason: automaticAttemptReason(domain.CodexAutomaticSwitchOutcomeEvaluating), CanCancel: true,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := m.beginAgentSwitchAttempt(); err != nil {
		return attempt, false, err
	}
	workerOwned := true
	defer func() {
		if workerOwned {
			m.agentSwitchWorkers.Done()
		}
	}()
	if err := m.beginAgentOperation(ctx, evidence.SessionID, agentOperationAutomaticProfileSwitch); err != nil {
		if errors.Is(err, errAgentOperationInProgress) {
			if active, ok, readErr := store.GetActiveCodexAutomaticProfileSwitchAttempt(ctx, evidence.SessionID); readErr == nil && ok {
				return active, false, nil
			}
			return attempt, false, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "Another session operation is in progress", nil)
		}
		return attempt, false, err
	}
	gateOwned := true
	defer func() {
		if gateOwned {
			m.endAgentOperation(evidence.SessionID, agentOperationAutomaticProfileSwitch)
		}
	}()
	stored, created, err := store.CreateCodexAutomaticProfileSwitchAttempt(ctx, attempt)
	if err != nil {
		if errors.Is(err, domain.ErrCodexAutomaticProfileSwitchAttemptConflict) {
			return stored, false, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "An automatic profile-switch attempt is already in progress", nil)
		}
		return stored, false, err
	}
	if !created {
		return stored, false, nil
	}
	go m.runCodexAutomaticProfileSwitch(store, stored)
	workerOwned, gateOwned = false, false
	return stored, true, nil
}

func (m *Manager) runCodexAutomaticProfileSwitch(store ports.CodexAutomaticProfileSwitchStore, attempt domain.CodexAutomaticProfileSwitchAttempt) {
	defer m.agentSwitchWorkers.Done()
	ctx := m.backgroundContext
	delegated := false
	defer func() {
		if !delegated {
			m.endAgentOperation(attempt.SourceSessionID, agentOperationAutomaticProfileSwitch)
		}
	}()
	for {
		policy, found, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, attempt.SourceSessionID)
		if err != nil || !found || !policy.Enabled {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomePolicyDisabled)
			return
		}
		if policy.Revision != attempt.PolicyRevision {
			previousRevision := attempt.PolicyRevision
			attempt.PolicyRevision = policy.Revision
			attempt.SelectedProfileID, attempt.SelectedProfilePosition = nil, nil
			attempt.OutcomeCode, attempt.UpdatedAt = domain.CodexAutomaticSwitchOutcomePolicyChanged, m.clock()
			if changed, updateErr := store.UpdateCodexAutomaticProfileSwitchAttempt(ctx, attempt, domain.CodexAutomaticProfileSwitchEvaluating, previousRevision); updateErr != nil || !changed {
				return
			}
			_ = store.ReplaceCodexAutomaticProfileSwitchAttemptCandidates(ctx, attempt.ID, nil)
		}
		source, found, err := m.store.GetSession(ctx, attempt.SourceSessionID)
		if err != nil || !found || source.ArchivedAt != nil || source.CodexProfileBinding == nil || source.CodexProfileBinding.ProfileID != attempt.SourceProfileID || codexSessionGeneration(source) != attempt.SourceGenerationID {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomeSourceNotCurrent)
			return
		}
		if _, err := m.codexAutomaticProfiles.VerifyCodexAutomaticProfileSwitchSource(ctx, *source.CodexProfileBinding); err != nil {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomeSourceUnverified)
			return
		}
		decisions := make([]domain.CodexAutomaticProfileSwitchAttemptCandidate, 0, len(policy.ProfileIDs))
		var selected *string
		var selectedPosition *int64
		for position, profileID := range policy.ProfileIDs {
			now := m.clock()
			decision := domain.CodexAutomaticProfileSwitchAttemptCandidate{ProfileID: profileID, Position: int64(position), EvaluatedAt: now}
			if profileID == attempt.SourceProfileID {
				decision.ReasonCode = domain.CodexAutomaticReasonCurrentProfile
			} else {
				_, reasonCode, verifyErr := m.codexAutomaticProfiles.VerifyCodexAutomaticProfileSwitchCandidate(ctx, profileID)
				decision.ReasonCode = reasonCode
				if verifyErr == nil && reasonCode == domain.CodexAutomaticReasonSelected {
					id, pos := profileID, int64(position)
					selected, selectedPosition = &id, &pos
				}
			}
			decision.Reason = automaticCandidateReason(decision.ReasonCode)
			decisions = append(decisions, decision)
			if selected != nil {
				break
			}
		}
		_ = store.ReplaceCodexAutomaticProfileSwitchAttemptCandidates(ctx, attempt.ID, decisions)
		latest, exists, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, attempt.SourceSessionID)
		if err != nil || !exists || !latest.Enabled {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomePolicyDisabled)
			return
		}
		if latest.Revision != policy.Revision {
			continue
		}
		if selected == nil {
			attempt.Candidates = decisions
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchNoCandidate, domain.CodexAutomaticSwitchOutcomeNoCandidate)
			return
		}
		attempt.Candidates, attempt.SelectedProfileID, attempt.SelectedProfilePosition = decisions, selected, selectedPosition
		sw, err := m.delegateAutomaticAttempt(ctx, store, attempt, source)
		if err != nil {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomeSourceUnverified)
			return
		}
		delegated = true
		profileSwitchStore, ok := store.(ports.CodexProfileSwitchStore)
		if !ok {
			m.finishAutomaticAttempt(store, &attempt, domain.CodexAutomaticProfileSwitchNeedsAttention, domain.CodexAutomaticSwitchOutcomeNeedsAttention)
			return
		}
		result, runErr := m.executeCodexProfileSwitch(ctx, profileSwitchStore, sw)
		if runErr != nil || result.Phase == domain.CodexProfileSwitchRecoveryRequired || result.Phase == domain.CodexProfileSwitchFailed {
			latestAttempt, ok, _ := store.GetCodexAutomaticProfileSwitchAttempt(context.WithoutCancel(ctx), attempt.ID)
			if ok && latestAttempt.State == domain.CodexAutomaticProfileSwitchDelegatedToPhase5 {
				m.finishAutomaticAttempt(store, &latestAttempt, domain.CodexAutomaticProfileSwitchNeedsAttention, domain.CodexAutomaticSwitchOutcomeNeedsAttention)
			}
		}
		return
	}
}

func (m *Manager) delegateAutomaticAttempt(ctx context.Context, store ports.CodexAutomaticProfileSwitchStore, attempt domain.CodexAutomaticProfileSwitchAttempt, source domain.SessionRecord) (domain.CodexProfileSwitch, error) {
	if attempt.SelectedProfileID == nil || attempt.SelectedProfilePosition == nil {
		return domain.CodexProfileSwitch{}, domain.ErrCodexAutomaticProfileSwitchAttemptConflict
	}
	now := m.clock()
	policyRevision := attempt.PolicyRevision
	switchID := domain.CodexProfileSwitchID("profile-switch-" + uuid.NewString())
	sw := domain.CodexProfileSwitch{
		ID: switchID, SourceSessionID: attempt.SourceSessionID, SourceProfileID: attempt.SourceProfileID,
		TargetProfileID: *attempt.SelectedProfileID, IdempotencyKey: "automatic:" + attempt.ID,
		RequestFingerprint: domain.ComputeAutomaticCodexProfileSwitchRequestFingerprint(attempt.SourceSessionID, *attempt.SelectedProfileID, attempt.ID, policyRevision),
		Trigger:            domain.CodexProfileSwitchTriggerExhausted, Phase: domain.CodexProfileSwitchRequested,
		WorkspaceOwner: domain.CodexProfileSwitchOwnerSource, SourceGenerationID: attempt.SourceGenerationID,
		SemanticHandoffStatus: domain.AgentHandoffNotAttempted, HandoffClassification: domain.CodexProfileSwitchHandoffPending,
		Initiator: domain.CodexProfileSwitchInitiatorAutomatic, AutomaticAttemptID: attempt.ID,
		AutomaticPolicyRevision: &policyRevision, RequestedAt: now, UpdatedAt: now,
	}
	if attempt.Trigger == domain.CodexAutomaticProfileSwitchUsageLimitFailure {
		sw.Trigger = domain.CodexProfileSwitchTriggerUsageLimitFailure
	}
	_, linkedSwitch, err := store.LinkAutomaticAttemptToCodexProfileSwitch(ctx, attempt, sw)
	if err != nil {
		return domain.CodexProfileSwitch{}, err
	}
	m.agentOpMu.Lock()
	if m.agentOperations[source.ID] != agentOperationAutomaticProfileSwitch {
		m.agentOpMu.Unlock()
		return domain.CodexProfileSwitch{}, apierr.Conflict("SESSION_OPERATION_IN_PROGRESS", "Automatic switch ownership was lost", nil)
	}
	m.agentOperations[source.ID] = agentOperationProfileSwitch
	m.agentOpMu.Unlock()
	return linkedSwitch, nil
}

func (m *Manager) finishAutomaticAttempt(store ports.CodexAutomaticProfileSwitchStore, attempt *domain.CodexAutomaticProfileSwitchAttempt, state domain.CodexAutomaticProfileSwitchState, outcome domain.CodexAutomaticProfileSwitchOutcomeCode) {
	previousState, previousRevision := attempt.State, attempt.PolicyRevision
	now := m.clock()
	attempt.State, attempt.OutcomeCode, attempt.Reason, attempt.CanCancel, attempt.UpdatedAt = state, outcome, automaticAttemptReason(outcome), false, now
	if state.Terminal() {
		attempt.CompletedAt = &now
	}
	_, _ = store.UpdateCodexAutomaticProfileSwitchAttempt(context.WithoutCancel(m.backgroundContext), *attempt, previousState, previousRevision)
}

// GetCodexAutomaticProfileSwitchAttempt returns one source-scoped durable attempt.
func (m *Manager) GetCodexAutomaticProfileSwitchAttempt(ctx context.Context, sessionID domain.SessionID, attemptID string) (domain.CodexAutomaticProfileSwitchAttempt, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		return domain.CodexAutomaticProfileSwitchAttempt{}, err
	}
	attempt, found, err := store.GetCodexAutomaticProfileSwitchAttempt(ctx, strings.TrimSpace(attemptID))
	if err != nil {
		return attempt, err
	}
	if !found || attempt.SourceSessionID != sessionID {
		return domain.CodexAutomaticProfileSwitchAttempt{}, ErrCodexAutomaticProfileSwitchAttemptNotFound
	}
	return m.decorateAutomaticAttempt(ctx, attempt), nil
}

// GetLatestCodexAutomaticProfileSwitchAttempt resolves source or continuation presentation.
func (m *Manager) GetLatestCodexAutomaticProfileSwitchAttempt(ctx context.Context, sessionID domain.SessionID) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		if errors.Is(err, ErrCodexAutomaticProfileSwitchUnavailable) {
			return domain.CodexAutomaticProfileSwitchAttempt{}, false, nil
		}
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
	}
	attempt, found, err := store.GetLatestCodexAutomaticProfileSwitchAttempt(ctx, sessionID)
	if err != nil {
		return attempt, false, err
	}
	if !found {
		if switchStore, ok := m.store.(ports.CodexProfileSwitchStore); ok {
			if sw, related, switchErr := switchStore.GetCodexProfileSwitchForSession(ctx, sessionID); switchErr != nil {
				return attempt, false, switchErr
			} else if related && sw.TargetSessionID != nil && *sw.TargetSessionID == sessionID && sw.AutomaticAttemptID != "" {
				attempt, found, err = store.GetCodexAutomaticProfileSwitchAttempt(ctx, sw.AutomaticAttemptID)
			}
		}
		if err != nil || !found {
			return attempt, found, err
		}
	}
	return m.decorateAutomaticAttempt(ctx, attempt), true, nil
}

// CancelCodexAutomaticProfileSwitchAttempt cancels evaluation or forwards to Phase 5.
func (m *Manager) CancelCodexAutomaticProfileSwitchAttempt(ctx context.Context, sessionID domain.SessionID, attemptID string) (domain.CodexAutomaticProfileSwitchAttempt, error) {
	store, err := m.codexAutomaticStore()
	if err != nil {
		return domain.CodexAutomaticProfileSwitchAttempt{}, err
	}
	attempt, found, err := store.GetCodexAutomaticProfileSwitchAttempt(ctx, strings.TrimSpace(attemptID))
	if err != nil {
		return attempt, err
	}
	if !found || attempt.SourceSessionID != sessionID {
		return domain.CodexAutomaticProfileSwitchAttempt{}, ErrCodexAutomaticProfileSwitchAttemptNotFound
	}
	attempt, err = m.cancelCodexAutomaticAttempt(ctx, store, attempt)
	return m.decorateAutomaticAttempt(ctx, attempt), err
}

func (m *Manager) cancelCodexAutomaticAttempt(ctx context.Context, store ports.CodexAutomaticProfileSwitchStore, attempt domain.CodexAutomaticProfileSwitchAttempt) (domain.CodexAutomaticProfileSwitchAttempt, error) {
	if attempt.State == domain.CodexAutomaticProfileSwitchEvaluating {
		previousRevision := attempt.PolicyRevision
		now := m.clock()
		attempt.State, attempt.OutcomeCode, attempt.Reason, attempt.CanCancel = domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomeCancelled, automaticAttemptReason(domain.CodexAutomaticSwitchOutcomeCancelled), false
		attempt.UpdatedAt, attempt.CompletedAt = now, &now
		changed, err := store.UpdateCodexAutomaticProfileSwitchAttempt(ctx, attempt, domain.CodexAutomaticProfileSwitchEvaluating, previousRevision)
		if err != nil {
			return attempt, err
		}
		if changed {
			m.endAgentOperation(attempt.SourceSessionID, agentOperationAutomaticProfileSwitch)
		}
		return attempt, nil
	}
	if attempt.State == domain.CodexAutomaticProfileSwitchDelegatedToPhase5 && attempt.ProfileSwitchID != nil {
		_, err := m.CancelCodexProfileSwitch(ctx, attempt.SourceSessionID, *attempt.ProfileSwitchID)
		if err != nil {
			return attempt, ErrCodexAutomaticProfileSwitchCancellationUnsafe
		}
		previousRevision := attempt.PolicyRevision
		now := m.clock()
		attempt.State, attempt.OutcomeCode, attempt.Reason, attempt.CanCancel = domain.CodexAutomaticProfileSwitchCancelled, domain.CodexAutomaticSwitchOutcomeCancelled, automaticAttemptReason(domain.CodexAutomaticSwitchOutcomeCancelled), false
		attempt.UpdatedAt, attempt.CompletedAt = now, &now
		_, err = store.UpdateCodexAutomaticProfileSwitchAttempt(ctx, attempt, domain.CodexAutomaticProfileSwitchDelegatedToPhase5, previousRevision)
		return attempt, err
	}
	return attempt, ErrCodexAutomaticProfileSwitchCancellationUnsafe
}

func (m *Manager) decorateAutomaticAttempt(ctx context.Context, attempt domain.CodexAutomaticProfileSwitchAttempt) domain.CodexAutomaticProfileSwitchAttempt {
	attempt.Reason = automaticAttemptReason(attempt.OutcomeCode)
	attempt.CanCancel = attempt.State == domain.CodexAutomaticProfileSwitchEvaluating
	if source, found, _ := m.store.GetSession(ctx, attempt.SourceSessionID); found && source.CodexProfileBinding != nil {
		summary := m.codexProfileSwitchOptions.CachedCodexProfileSwitchOptions(*source.CodexProfileBinding).SourceProfile
		attempt.SourceProfile = &summary
	}
	if attempt.SelectedProfileID != nil {
		entries := m.codexAutomaticProfiles.CachedCodexAutomaticProfileSwitchPolicyEntries("", []string{*attempt.SelectedProfileID})
		if len(entries) == 1 {
			source := domain.CodexProfileSourceExisting
			if entries[0].Source != nil {
				source = *entries[0].Source
			}
			summary := domain.CodexSessionProfileSummary{ID: entries[0].ID, Label: entries[0].Label, Source: source, Availability: entries[0].Availability, Capacity: entries[0].Capacity}
			attempt.TargetProfile = &summary
		}
	}
	if attempt.ProfileSwitchID != nil {
		if switchStore, ok := m.store.(ports.CodexProfileSwitchStore); ok {
			if sw, found, _ := switchStore.GetCodexProfileSwitch(ctx, *attempt.ProfileSwitchID); found {
				attempt.ProfileSwitch = &sw
				attempt.CanCancel = sw.Phase.Cancellable()
			}
		}
	}
	for i := range attempt.Candidates {
		attempt.Candidates[i].Reason = automaticCandidateReason(attempt.Candidates[i].ReasonCode)
	}
	return attempt
}

func codexSessionGeneration(rec domain.SessionRecord) domain.AgentGenerationID {
	if domain.NormalizeSessionMode(rec.Mode) == domain.SessionModeChat {
		return domain.AgentGenerationID(rec.Metadata.ControllerGeneration)
	}
	return domain.AgentGenerationID(rec.Metadata.RuntimeLaunchID)
}

func automaticAttemptReason(code domain.CodexAutomaticProfileSwitchOutcomeCode) string {
	switch code {
	case domain.CodexAutomaticSwitchOutcomePolicyDisabled:
		return "Automatic switching is disabled for this continuation chain."
	case domain.CodexAutomaticSwitchOutcomePolicyChanged:
		return "The approved fallback order changed; checking it again."
	case domain.CodexAutomaticSwitchOutcomeSourceAvailable:
		return "The source profile reports available capacity."
	case domain.CodexAutomaticSwitchOutcomeSourceUnverified:
		return "AO could not freshly confirm source exhaustion."
	case domain.CodexAutomaticSwitchOutcomeSourceNotCurrent:
		return "The exhausted session is no longer the current continuation."
	case domain.CodexAutomaticSwitchOutcomeNoCandidate:
		return "No approved fallback profile is currently eligible."
	case domain.CodexAutomaticSwitchOutcomeCancelled:
		return "Automatic switching was cancelled."
	case domain.CodexAutomaticSwitchOutcomeDelegated:
		return "Continuing through the safe profile-switch workflow."
	case domain.CodexAutomaticSwitchOutcomeCompleted:
		return "AO continued the task with an approved profile."
	case domain.CodexAutomaticSwitchOutcomeNeedsAttention:
		return "The continuation needs recovery attention."
	default:
		return "Checking approved fallback profiles."
	}
}

func automaticCandidateReason(code string) string {
	switch code {
	case domain.CodexAutomaticReasonCurrentProfile:
		return "The current profile is skipped."
	case domain.CodexAutomaticReasonProfileMissing:
		return "This configured profile is missing."
	case domain.CodexAutomaticReasonProfileUnavailable:
		return "This profile is unavailable."
	case domain.CodexAutomaticReasonAuthenticationRequired:
		return "This profile needs sign-in."
	case domain.CodexAutomaticReasonAuthenticationUnverified:
		return "Authentication could not be freshly verified."
	case domain.CodexAutomaticReasonCapacityNearLimit:
		return "This profile is near its limit."
	case domain.CodexAutomaticReasonCapacityExhausted:
		return "This profile is exhausted."
	case domain.CodexAutomaticReasonCapacityUnsupported:
		return "Subscription capacity is unsupported."
	case domain.CodexAutomaticReasonCapacityCheckFailed:
		return "Capacity could not be freshly checked."
	case domain.CodexAutomaticReasonSelected:
		return "This is the first freshly available approved profile."
	default:
		return "Capacity is unknown."
	}
}

// ReconcileCodexAutomaticProfileSwitches reacquires decision gates before
// normal session mutations are admitted. Phase 5 owns every linked switch.
func (m *Manager) ReconcileCodexAutomaticProfileSwitches(ctx context.Context) error {
	store, err := m.codexAutomaticStore()
	if err != nil {
		if errors.Is(err, ErrCodexAutomaticProfileSwitchUnavailable) {
			return nil
		}
		return err
	}
	attempts, err := store.ListActiveCodexAutomaticProfileSwitchAttempts(ctx)
	if err != nil {
		return err
	}
	for _, attempt := range attempts {
		if attempt.State == domain.CodexAutomaticProfileSwitchDelegatedToPhase5 {
			continue
		}
		if err := m.beginAgentSwitchAttempt(); err != nil {
			return err
		}
		m.adoptAgentOperation(attempt.SourceSessionID, agentOperationAutomaticProfileSwitch)
		go m.runCodexAutomaticProfileSwitch(store, attempt)
	}
	return nil
}
