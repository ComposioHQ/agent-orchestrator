package agent

import (
	"context"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// CachedCodexProfileSwitchOptions builds the assisted-switch surface solely
// from daemon-memory catalog, authentication, and capacity observations.
func (s *Service) CachedCodexProfileSwitchOptions(sourceBinding domain.CodexSessionBinding) domain.CodexProfileSwitchOptions {
	if s.codexProfiles == nil {
		return domain.CodexProfileSwitchOptions{SourceProfile: unavailableSwitchSource(sourceBinding), Candidates: []domain.CodexProfileSwitchCandidate{}}
	}
	profiles := s.codexProfiles.cached()
	return s.codexProfileSwitchOptions(sourceBinding, profiles.Profiles)
}

// EnsureCodexProfileSwitchOptions rediscovers descriptors and performs the
// normal display authentication/capacity ensures before ranking candidates.
func (s *Service) EnsureCodexProfileSwitchOptions(ctx context.Context, sourceBinding domain.CodexSessionBinding) (domain.CodexProfileSwitchOptions, error) {
	profiles, err := s.EnsureCodexProfileCapacity(ctx, nil)
	if err != nil {
		return domain.CodexProfileSwitchOptions{}, err
	}
	return s.codexProfileSwitchOptions(sourceBinding, profiles.Profiles), nil
}

// VerifyCodexProfileSwitchTarget performs a strict uncached proof immediately
// before source shutdown. Capacity uncertainty never masquerades as exhaustion,
// but it requires the user's durable acknowledgement.
func (s *Service) VerifyCodexProfileSwitchTarget(ctx context.Context, profileID string, acknowledgeUnknownCapacity bool) (domain.CodexProfileSwitchVerification, error) {
	if s.codexProfiles == nil {
		return domain.CodexProfileSwitchVerification{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return domain.CodexProfileSwitchVerification{}, apierr.NotFound("CODEX_PROFILE_NOT_FOUND", "Codex profile was not found")
	}
	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return domain.CodexProfileSwitchVerification{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := s.codexProfiles.catalog.record(profileID)
	if !ok || record.Snapshot.Source == domain.CodexProfileSourceLegacy {
		return domain.CodexProfileSwitchVerification{}, apierr.NotFound("CODEX_PROFILE_NOT_FOUND", "Codex profile was not found")
	}
	if record.Snapshot.Status != domain.CodexProfileStatusValid || ensureCodexLaunchHome(record) != nil {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_UNAVAILABLE", "The selected Codex profile is unavailable", map[string]any{"profileId": profileID})
	}

	// Force installation by invalidating the harness-wide observation first.
	s.readiness.Invalidate(string(domain.HarnessCodex), readinessInvalidateInstallation)
	if err := s.ensureCodexInstallationForLaunch(ctx); err != nil {
		return domain.CodexProfileSwitchVerification{}, err
	}
	capabilities := s.codexProfiles.detectCapabilities(ctx)
	if capabilities.AccountRead.State != domain.CodexCapabilitySupported {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile authentication could not be verified", map[string]any{"profileId": profileID})
	}
	auth, err := s.codexProfiles.ensureAuthentication(ctx, record, domain.AgentReadinessPurposeLaunch, true, true)
	if err != nil {
		return domain.CodexProfileSwitchVerification{}, err
	}
	if auth.State == domain.AgentAuthenticationUnauthorized && auth.Freshness == domain.AgentReadinessFresh {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_UNAUTHORIZED", "The selected Codex profile needs sign-in", map[string]any{"profileId": profileID})
	}
	if auth.State != domain.AgentAuthenticationAuthorized || auth.Freshness != domain.AgentReadinessFresh {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_STATE_UNVERIFIED", "Codex profile authentication could not be verified", map[string]any{"profileId": profileID})
	}

	current, _ := s.codexProfiles.catalog.record(profileID)
	capacity, capacityErr := s.codexProfiles.capacity.ensureOne(ctx, current, capabilities, true)
	if capacityErr != nil && !acknowledgeUnknownCapacity {
		return domain.CodexProfileSwitchVerification{}, apierr.Invalid("CODEX_PROFILE_SWITCH_CAPACITY_ACK_REQUIRED", "Capacity could not be verified; acknowledge the risk to continue", map[string]any{"profileId": profileID})
	}
	if capacity.Freshness == domain.AgentReadinessFresh && capacity.State == domain.CodexCapacityExhausted {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_EXHAUSTED", "The selected Codex profile is exhausted", map[string]any{"profileId": profileID})
	}
	capacityUnverified := capacity.Freshness != domain.AgentReadinessFresh || capacity.State == domain.CodexCapacityUnknown || capacity.State == domain.CodexCapacityUnsupported
	if capacityUnverified && !acknowledgeUnknownCapacity {
		return domain.CodexProfileSwitchVerification{}, apierr.Invalid("CODEX_PROFILE_SWITCH_CAPACITY_ACK_REQUIRED", "Capacity is unknown or unsupported; acknowledge the risk to continue", map[string]any{"profileId": profileID})
	}

	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return domain.CodexProfileSwitchVerification{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	verifiedRecord, ok := s.codexProfiles.catalog.record(profileID)
	if !ok || verifiedRecord.Snapshot.Status != domain.CodexProfileStatusValid ||
		verifiedRecord.Snapshot.Source != record.Snapshot.Source || canonicalPath(verifiedRecord.Home) != canonicalPath(record.Home) {
		return domain.CodexProfileSwitchVerification{}, apierr.Conflict("CODEX_PROFILE_UNAVAILABLE", "The selected Codex profile changed during verification", map[string]any{"profileId": profileID})
	}
	launch := domain.CodexLaunchContext{
		Binding: domain.CodexSessionBinding{ProfileID: profileID, Source: record.Snapshot.Source, Home: canonicalPath(record.Home), CreatedAt: s.codexProfiles.now()},
		Env:     map[string]string{"CODEX_HOME": canonicalPath(record.Home)}, Managed: record.Snapshot.Source == domain.CodexProfileSourceManaged,
		Authentication: auth,
	}
	profile := verifiedRecord.Snapshot
	profile.Authentication = auth
	profile.Capacity = capacity
	return domain.CodexProfileSwitchVerification{LaunchContext: launch, Profile: profile}, nil
}

func (s *Service) codexProfileSwitchOptions(sourceBinding domain.CodexSessionBinding, profiles []domain.CodexProfileSnapshot) domain.CodexProfileSwitchOptions {
	options := domain.CodexProfileSwitchOptions{
		SourceProfile: s.CodexSessionProfileSummary(sourceBinding),
		Candidates:    make([]domain.CodexProfileSwitchCandidate, 0, len(profiles)),
	}
	type ranked struct {
		candidate domain.CodexProfileSwitchCandidate
		tier      int
		used      float64
		order     int
	}
	rankedCandidates := make([]ranked, 0, len(profiles))
	for order, profile := range profiles {
		if profile.ID == sourceBinding.ProfileID {
			if options.SourceProfile.Capacity == nil {
				capacity := domain.CompactCodexCapacity(profile.Capacity)
				options.SourceProfile.Capacity = &capacity
			}
			continue
		}
		candidate, tier := classifyCodexProfileSwitchCandidate(profile)
		used := 101.0
		if profile.Capacity.UsedPercent != nil {
			used = *profile.Capacity.UsedPercent
		}
		rankedCandidates = append(rankedCandidates, ranked{candidate: candidate, tier: tier, used: used, order: order})
	}
	sort.SliceStable(rankedCandidates, func(i, j int) bool {
		if rankedCandidates[i].tier != rankedCandidates[j].tier {
			return rankedCandidates[i].tier < rankedCandidates[j].tier
		}
		if rankedCandidates[i].tier <= 1 && rankedCandidates[i].used != rankedCandidates[j].used {
			return rankedCandidates[i].used < rankedCandidates[j].used
		}
		return rankedCandidates[i].order < rankedCandidates[j].order
	})
	recommendedTier := -1
	if len(rankedCandidates) > 0 && rankedCandidates[0].tier == 0 {
		recommendedTier = 0
	} else if len(rankedCandidates) > 0 && rankedCandidates[0].tier == 1 {
		recommendedTier = 1
	}
	for i := range rankedCandidates {
		entry := rankedCandidates[i]
		if options.RecommendedProfileID == nil && entry.tier == recommendedTier {
			entry.candidate.Recommended = true
			if entry.tier == 0 {
				entry.candidate.ReasonCode = domain.CodexProfileSwitchReasonRecommendedAvailable
				entry.candidate.Reason = "This authenticated profile has the most reported capacity."
			} else {
				entry.candidate.ReasonCode = domain.CodexProfileSwitchReasonRecommendedNearLimit
				entry.candidate.Reason = "No available profile was reported; this authenticated profile is near its limit."
			}
			id := entry.candidate.ID
			options.RecommendedProfileID = &id
		}
		options.Candidates = append(options.Candidates, entry.candidate)
	}
	return options
}

func classifyCodexProfileSwitchCandidate(profile domain.CodexProfileSnapshot) (domain.CodexProfileSwitchCandidate, int) {
	candidate := domain.CodexProfileSwitchCandidate{
		ID: profile.ID, Label: profile.Label, Source: profile.Source,
		Authentication: profile.Authentication, Capacity: profile.Capacity,
	}
	if profile.Status != domain.CodexProfileStatusValid {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonProfileUnavailable, "This Codex profile is unavailable."
		return candidate, 6
	}
	auth := profile.Authentication
	if auth.State == domain.AgentAuthenticationUnauthorized && auth.Freshness == domain.AgentReadinessFresh {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonAuthenticationRequired, "Sign in before selecting this profile."
		return candidate, 5
	}
	if auth.State != domain.AgentAuthenticationAuthorized || auth.Freshness != domain.AgentReadinessFresh {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonAuthenticationUnverified, "Authentication must be verified before switching."
		return candidate, 5
	}
	capacity := profile.Capacity
	if capacity.Freshness == domain.AgentReadinessFresh && capacity.State == domain.CodexCapacityExhausted {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonCapacityExhausted, "This profile reports no remaining capacity."
		return candidate, 4
	}
	if capacity.Freshness == domain.AgentReadinessFresh && capacity.State == domain.CodexCapacityAvailable {
		candidate.Selectable = true
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonSelectableAvailable, "This authenticated profile reports available capacity."
		return candidate, 0
	}
	if capacity.Freshness == domain.AgentReadinessFresh && capacity.State == domain.CodexCapacityNearLimit {
		candidate.Selectable = true
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonSelectableNearLimit, "This authenticated profile is also near its limit."
		return candidate, 1
	}
	candidate.Selectable = true
	candidate.RequiresCapacityAcknowledgement = true
	if capacity.Freshness == domain.AgentReadinessChecking {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonCapacityChecking, "Capacity is still being checked; acknowledgement is required."
	} else {
		candidate.ReasonCode, candidate.Reason = domain.CodexProfileSwitchReasonCapacityAckRequired, "Capacity is unknown, stale, or unsupported; acknowledgement is required."
	}
	return candidate, 2
}

func unavailableSwitchSource(binding domain.CodexSessionBinding) domain.CodexSessionProfileSummary {
	label := "Unavailable Codex profile"
	if binding.Source == domain.CodexProfileSourceLegacy {
		label = "Legacy Codex profile"
	}
	return domain.CodexSessionProfileSummary{ID: binding.ProfileID, Label: label, Source: binding.Source, Availability: domain.CodexProfileUnknown}
}
