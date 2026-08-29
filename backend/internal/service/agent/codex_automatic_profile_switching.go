package agent

import (
	"context"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// CachedCodexAutomaticProfileSwitchPolicyEntries projects the configured
// allowlist from memory only. Missing configured profiles stay visible.
func (s *Service) CachedCodexAutomaticProfileSwitchPolicyEntries(currentProfileID string, profileIDs []string) []domain.CodexAutomaticProfileSwitchPolicyEntry {
	byID := make(map[string]domain.CodexProfileSnapshot)
	if s.codexProfiles != nil {
		for _, profile := range s.codexProfiles.cached().Profiles {
			byID[profile.ID] = profile
		}
	}
	entries := make([]domain.CodexAutomaticProfileSwitchPolicyEntry, 0, len(profileIDs))
	for _, id := range profileIDs {
		id = strings.TrimSpace(id)
		profile, ok := byID[id]
		if !ok {
			entries = append(entries, domain.CodexAutomaticProfileSwitchPolicyEntry{
				ID: id, Label: "Unavailable Codex profile", Availability: domain.CodexProfileUnavailable,
				Current: id == currentProfileID, ReasonCode: domain.CodexAutomaticReasonProfileMissing,
				Reason: "This configured Codex profile is no longer available.",
			})
			continue
		}
		entries = append(entries, cachedAutomaticPolicyEntry(profile, id == currentProfileID))
	}
	return entries
}

func cachedAutomaticPolicyEntry(profile domain.CodexProfileSnapshot, current bool) domain.CodexAutomaticProfileSwitchPolicyEntry {
	source := profile.Source
	auth := profile.Authentication
	capacity := domain.CompactCodexCapacity(profile.Capacity)
	entry := domain.CodexAutomaticProfileSwitchPolicyEntry{
		ID: profile.ID, Label: profile.Label, Source: &source, Availability: domain.CodexProfileAvailable,
		Authentication: &auth, Capacity: &capacity, Current: current,
	}
	switch {
	case current:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCurrentProfile, "The current profile is skipped until another continuation uses a different profile."
	case profile.Status != domain.CodexProfileStatusValid:
		entry.Availability = domain.CodexProfileUnavailable
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonProfileUnavailable, "This Codex profile is unavailable."
	case auth.State == domain.AgentAuthenticationUnauthorized && auth.Freshness == domain.AgentReadinessFresh:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonAuthenticationRequired, "Sign in before this profile can be used automatically."
	case auth.State != domain.AgentAuthenticationAuthorized || auth.Freshness != domain.AgentReadinessFresh:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonAuthenticationUnverified, "Authentication must be freshly verified."
	case capacity.Freshness != domain.AgentReadinessFresh:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCapacityUnknown, "Capacity must be freshly verified."
	case capacity.State == domain.CodexCapacityAvailable:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonProfileAvailable, "This profile is currently eligible for automatic switching."
	case capacity.State == domain.CodexCapacityNearLimit:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCapacityNearLimit, "This profile is near its limit and will be skipped."
	case capacity.State == domain.CodexCapacityExhausted:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCapacityExhausted, "This profile is exhausted and will be skipped."
	case capacity.State == domain.CodexCapacityUnsupported:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCapacityUnsupported, "Subscription capacity is unsupported for this profile."
	default:
		entry.ReasonCode, entry.Reason = domain.CodexAutomaticReasonCapacityUnknown, "Capacity is unknown and this profile will be skipped."
	}
	return entry
}

// ValidateCodexAutomaticProfileSwitchPolicyProfiles refreshes descriptors but
// intentionally performs no authentication or capacity work. IDs already in
// the policy may remain missing; newly introduced IDs must be selectable
// catalog identities.
func (s *Service) ValidateCodexAutomaticProfileSwitchPolicyProfiles(ctx context.Context, retainedProfileIDs, requestedProfileIDs []string) error {
	if s.codexProfiles == nil {
		return apierr.Unavailable("CODEX_AUTOMATIC_PROFILE_SWITCH_UNAVAILABLE", "Automatic Codex profile switching is unavailable")
	}
	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return apierr.Unavailable("CODEX_AUTOMATIC_PROFILE_SWITCH_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	retained := make(map[string]struct{}, len(retainedProfileIDs))
	for _, id := range retainedProfileIDs {
		retained[id] = struct{}{}
	}
	for _, id := range requestedProfileIDs {
		if _, ok := retained[id]; ok {
			continue
		}
		record, ok := s.codexProfiles.catalog.record(id)
		if !ok || (record.Snapshot.Source != domain.CodexProfileSourceExisting && record.Snapshot.Source != domain.CodexProfileSourceManaged) {
			return apierr.Invalid("UNKNOWN_CODEX_PROFILE_ID", "A configured Codex profile was not found", map[string]any{"profileId": id})
		}
	}
	return nil
}

// VerifyCodexAutomaticProfileSwitchSource proves the exact source still
// reports fresh exhaustion. Inconclusive state always fails closed.
func (s *Service) VerifyCodexAutomaticProfileSwitchSource(ctx context.Context, binding domain.CodexSessionBinding) (domain.CodexProfileSnapshot, error) {
	verification, err := s.verifyAutomaticProfile(ctx, binding.ProfileID)
	if err != nil {
		return domain.CodexProfileSnapshot{}, err
	}
	if verification.LaunchContext.Binding.Source != binding.Source || canonicalPath(verification.LaunchContext.Binding.Home) != canonicalPath(binding.Home) {
		return domain.CodexProfileSnapshot{}, apierr.Conflict("CODEX_AUTOMATIC_PROFILE_SWITCH_SOURCE_UNVERIFIED", "The bound Codex profile changed during verification", nil)
	}
	capacity := verification.Profile.Capacity
	if capacity.Freshness != domain.AgentReadinessFresh || capacity.State != domain.CodexCapacityExhausted {
		return verification.Profile, apierr.Conflict("CODEX_AUTOMATIC_PROFILE_SWITCH_SOURCE_UNVERIFIED", "The source profile is not freshly confirmed exhausted", nil)
	}
	return verification.Profile, nil
}

// VerifyCodexAutomaticProfileSwitchCandidate accepts only fresh authorized,
// fresh available targets and returns a stable decision for every safe skip.
func (s *Service) VerifyCodexAutomaticProfileSwitchCandidate(ctx context.Context, profileID string) (domain.CodexProfileSwitchVerification, string, error) {
	verification, err := s.verifyAutomaticProfile(ctx, profileID)
	if err != nil {
		var structured *apierr.Error
		_ = errors.As(err, &structured)
		if structured != nil && structured.Code == "CODEX_PROFILE_NOT_FOUND" {
			return verification, domain.CodexAutomaticReasonProfileMissing, err
		}
		if structured != nil && structured.Code == "CODEX_PROFILE_UNAUTHORIZED" {
			return verification, domain.CodexAutomaticReasonAuthenticationRequired, err
		}
		if structured != nil && structured.Code == "CODEX_PROFILE_STATE_UNVERIFIED" {
			return verification, domain.CodexAutomaticReasonAuthenticationUnverified, err
		}
		return verification, domain.CodexAutomaticReasonProfileUnavailable, err
	}
	capacity := verification.Profile.Capacity
	if capacity.Freshness != domain.AgentReadinessFresh {
		return verification, domain.CodexAutomaticReasonCapacityCheckFailed, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile capacity could not be verified", nil)
	}
	switch capacity.State {
	case domain.CodexCapacityAvailable:
		return verification, domain.CodexAutomaticReasonSelected, nil
	case domain.CodexCapacityNearLimit:
		return verification, domain.CodexAutomaticReasonCapacityNearLimit, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile is near its limit", nil)
	case domain.CodexCapacityExhausted:
		return verification, domain.CodexAutomaticReasonCapacityExhausted, apierr.Conflict("CODEX_PROFILE_EXHAUSTED", "Codex profile is exhausted", nil)
	case domain.CodexCapacityUnsupported:
		return verification, domain.CodexAutomaticReasonCapacityUnsupported, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile capacity is unsupported", nil)
	default:
		return verification, domain.CodexAutomaticReasonCapacityUnknown, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile capacity is unknown", nil)
	}
}

func (s *Service) verifyAutomaticProfile(ctx context.Context, profileID string) (domain.CodexProfileSwitchVerification, error) {
	// Phase 5's strict verifier already rechecks the descriptor, installation,
	// authentication, capacity, and exact home. Automatic mode never permits its
	// advisory capacity acknowledgement escape hatch.
	return s.VerifyCodexProfileSwitchTarget(ctx, strings.TrimSpace(profileID), false)
}
