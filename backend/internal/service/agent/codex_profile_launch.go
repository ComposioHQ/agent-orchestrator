package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// ResolveCodexLegacyBinding classifies durable historical home evidence
// without starting Codex or reading credentials. An empty candidate selects
// the current existing profile as the final backfill fallback.
func (s *Service) ResolveCodexLegacyBinding(_ context.Context, sessionID domain.SessionID, candidateHome string, createdAt time.Time) (domain.CodexSessionBinding, error) {
	if s.codexProfiles == nil {
		return domain.CodexSessionBinding{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return domain.CodexSessionBinding{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	candidateHome = strings.TrimSpace(candidateHome)
	if candidateHome == "" {
		record, ok := s.codexProfiles.catalog.record(codexExistingProfileID)
		if !ok {
			return domain.CodexSessionBinding{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Existing Codex profile is unavailable")
		}
		return domain.CodexSessionBinding{SessionID: sessionID, ProfileID: record.Snapshot.ID, Source: record.Snapshot.Source, Home: canonicalPath(record.Home), CreatedAt: createdAt}, nil
	}
	home := canonicalPath(candidateHome)
	if !safeExistingCodexDirectory(home) {
		return domain.CodexSessionBinding{}, errors.New("historical Codex home is unsafe")
	}
	records, err := s.codexProfiles.catalog.recordsFor(nil)
	if err != nil {
		return domain.CodexSessionBinding{}, err
	}
	for _, record := range records {
		if record.Snapshot.Status == domain.CodexProfileStatusValid && canonicalPath(record.Home) == home {
			return domain.CodexSessionBinding{SessionID: sessionID, ProfileID: record.Snapshot.ID, Source: record.Snapshot.Source, Home: home, CreatedAt: createdAt}, nil
		}
	}
	return domain.CodexSessionBinding{SessionID: sessionID, ProfileID: "legacy:" + string(sessionID), Source: domain.CodexProfileSourceLegacy, Home: home, CreatedAt: createdAt}, nil
}

// ResolveCodexProfileForLaunch resolves a selectable catalog profile into an
// exact, invocation-scoped launch context. It never accepts labels or paths.
func (s *Service) ResolveCodexProfileForLaunch(ctx context.Context, profileID string) (domain.CodexLaunchContext, error) {
	if s.codexProfiles == nil {
		return domain.CodexLaunchContext{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		profileID = codexExistingProfileID
	}
	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return domain.CodexLaunchContext{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := s.codexProfiles.catalog.record(profileID)
	if !ok || record.Snapshot.Source == domain.CodexProfileSourceLegacy {
		return domain.CodexLaunchContext{}, apierr.Invalid("UNKNOWN_CODEX_PROFILE_ID", "Unknown Codex profile", map[string]any{"profileId": profileID})
	}
	return s.resolveCodexRecordForLaunch(ctx, record)
}

// ValidateCodexSessionBinding revalidates the exact pinned home. A missing or
// changed descriptor cannot redirect a session to a different profile.
func (s *Service) ValidateCodexSessionBinding(ctx context.Context, binding domain.CodexSessionBinding) (domain.CodexLaunchContext, error) {
	if s.codexProfiles == nil {
		return domain.CodexLaunchContext{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	if binding.Source == domain.CodexProfileSourceLegacy {
		if err := s.ensureCodexInstallationForLaunch(ctx); err != nil {
			return domain.CodexLaunchContext{}, err
		}
		if !safeExistingCodexDirectory(binding.Home) {
			return domain.CodexLaunchContext{}, codexProfileUnavailable(binding.ProfileID)
		}
		return domain.CodexLaunchContext{
			Binding: binding,
			Env:     map[string]string{"CODEX_HOME": binding.Home},
			Authentication: domain.AgentAuthenticationObservation{
				State: domain.AgentAuthenticationUnknown, Freshness: domain.AgentReadinessStale,
				ReasonCode: domain.AgentReadinessReasonNotChecked, Reason: "Authentication is validated by Codex for this legacy session.",
			},
		}, nil
	}
	if err := s.codexProfiles.catalog.refresh(); err != nil {
		return domain.CodexLaunchContext{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := s.codexProfiles.catalog.record(binding.ProfileID)
	if !ok || record.Snapshot.Source != binding.Source || canonicalPath(record.Home) != canonicalPath(binding.Home) {
		return domain.CodexLaunchContext{}, codexProfileUnavailable(binding.ProfileID)
	}
	resolved, err := s.resolveCodexRecordForLaunch(ctx, record)
	if err != nil {
		return domain.CodexLaunchContext{}, err
	}
	resolved.Binding.SessionID = binding.SessionID
	resolved.Binding.CreatedAt = binding.CreatedAt
	return resolved, nil
}

func (s *Service) resolveCodexRecordForLaunch(ctx context.Context, record codexProfileRecord) (domain.CodexLaunchContext, error) {
	if record.Snapshot.Status != domain.CodexProfileStatusValid {
		return domain.CodexLaunchContext{}, codexProfileUnavailable(record.Snapshot.ID)
	}
	if err := s.ensureCodexInstallationForLaunch(ctx); err != nil {
		return domain.CodexLaunchContext{}, err
	}
	if err := ensureCodexLaunchHome(record); err != nil {
		return domain.CodexLaunchContext{}, codexProfileUnavailable(record.Snapshot.ID)
	}

	auth := record.Snapshot.Authentication
	capabilities := s.codexProfiles.detectCapabilities(ctx)
	switch capabilities.AccountRead.State {
	case domain.CodexCapabilitySupported:
		observation, err := s.codexProfiles.ensureAuthentication(ctx, record, domain.AgentReadinessPurposeLaunch, false, true)
		if err != nil {
			return domain.CodexLaunchContext{}, err
		}
		auth = observation
	case domain.CodexCapabilityUnsupported:
		if record.Snapshot.Source == domain.CodexProfileSourceExisting {
			snapshots, err := s.readiness.Ensure(ctx, []string{string(domain.HarnessCodex)}, domain.AgentReadinessPurposeLaunch)
			if err != nil {
				return domain.CodexLaunchContext{}, err
			}
			if len(snapshots) > 0 {
				auth = snapshots[0].Authentication
				s.syncExistingCodexProfile()
			}
		} else {
			auth = failedAuthentication(s.codexProfiles.now(), domain.AgentReadinessReasonAuthCheckUnsupported, "Structured authentication is not supported by this Codex version.")
		}
	default:
		auth = failedAuthentication(s.codexProfiles.now(), domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication could not be checked.")
	}

	if auth.State == domain.AgentAuthenticationUnauthorized && auth.Freshness == domain.AgentReadinessFresh {
		return domain.CodexLaunchContext{}, apierr.Conflict("CODEX_PROFILE_UNAUTHORIZED", "The selected Codex profile needs sign-in", map[string]any{"profileId": record.Snapshot.ID})
	}
	now := s.codexProfiles.now()
	launch := domain.CodexLaunchContext{
		Binding: domain.CodexSessionBinding{
			ProfileID: record.Snapshot.ID, Source: record.Snapshot.Source,
			Home: canonicalPath(record.Home), CreatedAt: now,
		},
		Env:            map[string]string{"CODEX_HOME": canonicalPath(record.Home)},
		Managed:        record.Snapshot.Source == domain.CodexProfileSourceManaged,
		Authentication: auth,
	}
	// Capacity is advisory. Start or join a stale read only after launch
	// readiness has succeeded, and never make workspace/process creation wait.
	go func(record codexProfileRecord, capabilities domain.CodexProfileCapabilities) {
		_, _ = s.codexProfiles.capacity.ensureOne(s.codexProfiles.ctx, record, capabilities, false)
	}(record, capabilities)
	return launch, nil
}

func (s *Service) ensureCodexInstallationForLaunch(ctx context.Context) error {
	installation, err := s.readiness.EnsureInstallation(ctx, []string{string(domain.HarnessCodex)}, domain.AgentReadinessPurposeLaunch)
	if err != nil {
		return err
	}
	if len(installation) > 0 && installation[0].Installation.State == domain.AgentInstallationNotInstalled {
		return apierr.Invalid("AGENT_BINARY_NOT_FOUND", "The selected agent harness is not installed", map[string]any{"agentId": domain.HarnessCodex})
	}
	return nil
}

func ensureCodexLaunchHome(record codexProfileRecord) error {
	home := canonicalPath(record.Home)
	if home == "" || !filepath.IsAbs(home) {
		return errors.New("invalid Codex home")
	}
	info, err := os.Lstat(home)
	if errors.Is(err, os.ErrNotExist) && record.Snapshot.Source == domain.CodexProfileSourceExisting && isDefaultCodexHome(home) {
		if err := os.MkdirAll(home, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(home, 0o700); err != nil { //nolint:gosec // Codex's default credential home must be owner-only.
			return err
		}
		info, err = os.Lstat(home)
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("codex home is unavailable")
	}
	if record.Snapshot.Source == domain.CodexProfileSourceManaged && info.Mode().Perm() != 0o700 {
		return errors.New("managed Codex home permissions are unsafe")
	}
	return nil
}

func safeExistingCodexDirectory(home string) bool {
	home = strings.TrimSpace(home)
	if home == "" || !filepath.IsAbs(home) || filepath.Clean(home) != home {
		return false
	}
	resolved, err := filepath.EvalSymlinks(home)
	if err != nil || filepath.Clean(resolved) != home {
		return false
	}
	info, err := os.Lstat(home)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func isDefaultCodexHome(home string) bool {
	if strings.TrimSpace(os.Getenv("CODEX_HOME")) != "" {
		return false
	}
	userHome, err := os.UserHomeDir()
	return err == nil && canonicalPath(filepath.Join(userHome, ".codex")) == canonicalPath(home)
}

func codexProfileUnavailable(profileID string) error {
	return apierr.Conflict("CODEX_PROFILE_UNAVAILABLE", "The selected Codex profile is unavailable", map[string]any{"profileId": profileID})
}

// CodexSessionProfileSummary returns a cached, path-free projection. It does no
// filesystem or native work and therefore remains safe for ordinary session reads.
func (s *Service) CodexSessionProfileSummary(binding domain.CodexSessionBinding) domain.CodexSessionProfileSummary {
	summary := domain.CodexSessionProfileSummary{ID: binding.ProfileID, Source: binding.Source, Availability: domain.CodexProfileUnknown}
	if s.codexProfiles != nil {
		capacity := domain.CompactCodexCapacity(s.codexProfiles.capacity.snapshot(binding.ProfileID))
		summary.Capacity = &capacity
	}
	if binding.Source == domain.CodexProfileSourceLegacy {
		summary.Label = "Legacy Codex profile"
		return summary
	}
	if s.codexProfiles == nil {
		summary.Label = "Unavailable Codex profile"
		return summary
	}
	record, ok := s.codexProfiles.catalog.record(binding.ProfileID)
	if !ok || record.Snapshot.Source != binding.Source || canonicalPath(record.Home) != canonicalPath(binding.Home) || record.Snapshot.Status != domain.CodexProfileStatusValid {
		summary.Label = "Unavailable Codex profile"
		summary.Availability = domain.CodexProfileUnavailable
		return summary
	}
	summary.Label = record.Snapshot.Label
	summary.Availability = domain.CodexProfileAvailable
	return summary
}
