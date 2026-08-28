package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type codexBindingWriter interface {
	BindCodexSessionProfile(context.Context, domain.CodexSessionBinding) (domain.CodexSessionBinding, bool, error)
}

func (m *Manager) resolveInitialCodexLaunch(ctx context.Context, cfg ports.SpawnConfig) (*domain.CodexLaunchContext, error) {
	profileID := strings.TrimSpace(cfg.ProfileID)
	var parent *domain.SessionRecord
	if cfg.ParentSessionID != "" {
		record, found, err := m.store.GetSession(ctx, cfg.ParentSessionID)
		if err != nil {
			return nil, fmt.Errorf("read parent session: %w", err)
		}
		if !found {
			return nil, apierr.NotFound("PARENT_SESSION_NOT_FOUND", "Parent session not found")
		}
		parent = &record
	}
	if cfg.Harness != domain.HarnessCodex {
		if profileID != "" {
			return nil, apierr.Invalid("CODEX_PROFILE_REQUIRES_CODEX", "A Codex profile can only be used with the Codex harness", map[string]any{"profileId": profileID})
		}
		return nil, nil
	}
	if m.codexProfiles == nil {
		if profileID != "" || cfg.ParentSessionID != "" {
			return nil, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile-bound launches are unavailable")
		}
		return nil, nil
	}
	if profileID != "" {
		resolved, err := m.codexProfiles.ResolveCodexProfileForLaunch(ctx, profileID)
		return &resolved, err
	}
	if parent != nil {
		if parent.CodexProfileBinding != nil {
			resolved, err := m.codexProfiles.ValidateCodexSessionBinding(ctx, *parent.CodexProfileBinding)
			if err != nil {
				return nil, err
			}
			// A child owns an independent immutable row even though it inherits the
			// exact profile identity and canonical home.
			resolved.Binding.SessionID = ""
			resolved.Binding.CreatedAt = m.clock()
			return &resolved, nil
		}
	}
	resolved, err := m.codexProfiles.ResolveCodexProfileForLaunch(ctx, "existing")
	return &resolved, err
}

func (m *Manager) codexLaunchForRecord(ctx context.Context, rec *domain.SessionRecord) (*domain.CodexLaunchContext, error) {
	if m.codexProfiles == nil {
		if rec.CodexProfileBinding != nil {
			return nil, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile-bound launches are unavailable")
		}
		return nil, nil
	}
	if rec.CodexProfileBinding != nil {
		resolved, err := m.codexProfiles.ValidateCodexSessionBinding(ctx, *rec.CodexProfileBinding)
		if err != nil {
			return nil, err
		}
		return &resolved, nil
	}
	if err := m.backfillCodexBinding(ctx, rec, false); err != nil {
		return nil, err
	}
	if rec.CodexProfileBinding != nil {
		resolved, err := m.codexProfiles.ValidateCodexSessionBinding(ctx, *rec.CodexProfileBinding)
		return &resolved, err
	}
	resolved, err := m.codexProfiles.ResolveCodexProfileForLaunch(ctx, "existing")
	if err != nil {
		return nil, err
	}
	resolved.Binding.SessionID = rec.ID
	resolved.Binding.CreatedAt = m.clock()
	bound, err := m.persistCodexBinding(ctx, resolved.Binding)
	if err != nil {
		return nil, err
	}
	rec.CodexProfileBinding = &bound
	resolved.Binding = bound
	return &resolved, nil
}

// ResolveCodexReviewerLaunch binds an unbound worker before its first Codex
// reviewer starts and returns the same exact context used by ordinary sessions.
func (m *Manager) ResolveCodexReviewerLaunch(ctx context.Context, sessionID domain.SessionID) (domain.CodexLaunchContext, error) {
	rec, found, err := m.store.GetSession(ctx, sessionID)
	if err != nil {
		return domain.CodexLaunchContext{}, err
	}
	if !found {
		return domain.CodexLaunchContext{}, ErrNotFound
	}
	if rec.CodexProfileBinding == nil {
		_ = m.backfillCodexBinding(ctx, &rec, false)
	}
	if rec.CodexProfileBinding == nil {
		if m.codexProfiles == nil {
			return domain.CodexLaunchContext{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile-bound launches are unavailable")
		}
		resolved, resolveErr := m.codexProfiles.ResolveCodexProfileForLaunch(ctx, "existing")
		if resolveErr != nil {
			return domain.CodexLaunchContext{}, resolveErr
		}
		resolved.Binding.SessionID = rec.ID
		resolved.Binding.CreatedAt = m.clock()
		bound, bindErr := m.persistCodexBinding(ctx, resolved.Binding)
		if bindErr != nil {
			return domain.CodexLaunchContext{}, bindErr
		}
		rec.CodexProfileBinding = &bound
		resolved.Binding = bound
		return resolved, nil
	}
	return m.codexProfiles.ValidateCodexSessionBinding(ctx, *rec.CodexProfileBinding)
}

// WarmCodexBindings performs bounded, asynchronous migration of historical
// Codex sessions. It never starts or restarts a session process.
func (m *Manager) WarmCodexBindings(ctx context.Context) {
	go func() {
		records, err := m.store.ListAllSessions(ctx)
		if err != nil {
			m.logger.Warn("Codex binding backfill could not list sessions", "error", err)
			return
		}
		const workerCount = 4
		jobs := make(chan domain.SessionRecord)
		var wg sync.WaitGroup
		wg.Add(workerCount)
		for range workerCount {
			go func() {
				defer wg.Done()
				for rec := range jobs {
					if err := m.backfillCodexBinding(ctx, &rec, true); err != nil {
						m.logger.Warn("Codex binding backfill skipped session", "sessionID", rec.ID, "error", err)
					}
				}
			}()
		}
		for _, rec := range records {
			select {
			case jobs <- rec:
			case <-ctx.Done():
				close(jobs)
				wg.Wait()
				return
			}
		}
		close(jobs)
		wg.Wait()
	}()
}

func (m *Manager) backfillCodexBinding(ctx context.Context, rec *domain.SessionRecord, historicalOnly bool) error {
	if rec.CodexProfileBinding != nil || m.codexProfiles == nil {
		return nil
	}
	var candidates []string
	hasCodexEvidence := rec.Harness == domain.HarnessCodex
	if store, ok := m.store.(ports.AgentSwitchStore); ok {
		native, err := store.ListAgentNativeSessions(ctx, rec.ID)
		if err != nil {
			return err
		}
		for _, retained := range native {
			if retained.Harness != domain.HarnessCodex {
				continue
			}
			hasCodexEvidence = true
			if strings.TrimSpace(retained.ConfigDir) != "" {
				candidates = append(candidates, retained.ConfigDir)
			}
			if home := codexHomeFromTranscript(retained.TranscriptPath); home != "" {
				candidates = append(candidates, home)
			}
		}
	}
	if rec.Harness == domain.HarnessCodex {
		if home := codexHomeFromTranscript(rec.Metadata.NativeTranscriptPath); home != "" {
			candidates = append(candidates, home)
		}
	}
	if historicalOnly && !hasCodexEvidence {
		return nil
	}
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidate = filepath.Clean(strings.TrimSpace(candidate))
		if candidate == "." {
			continue
		}
		if _, duplicate := seen[candidate]; duplicate {
			continue
		}
		seen[candidate] = struct{}{}
		binding, err := m.codexProfiles.ResolveCodexLegacyBinding(ctx, rec.ID, candidate, rec.CreatedAt)
		if err != nil {
			continue
		}
		bound, err := m.persistCodexBinding(ctx, binding)
		if err != nil {
			return err
		}
		rec.CodexProfileBinding = &bound
		return nil
	}
	if !hasCodexEvidence {
		return nil
	}
	binding, err := m.codexProfiles.ResolveCodexLegacyBinding(ctx, rec.ID, "", rec.CreatedAt)
	if err != nil {
		return err
	}
	bound, err := m.persistCodexBinding(ctx, binding)
	if err != nil {
		return err
	}
	rec.CodexProfileBinding = &bound
	return nil
}

func codexHomeFromTranscript(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return ""
	}
	clean := filepath.Clean(path)
	parts := strings.Split(filepath.ToSlash(clean), "/")
	for i := len(parts) - 2; i >= 1; i-- {
		if parts[i] != "sessions" && parts[i] != "archived_sessions" {
			continue
		}
		home := filepath.FromSlash(strings.Join(parts[:i], "/"))
		if strings.HasPrefix(clean, string(filepath.Separator)) {
			home = string(filepath.Separator) + home
		}
		return filepath.Clean(home)
	}
	return ""
}

func (m *Manager) codexLaunchForSwitch(ctx context.Context, rec *domain.SessionRecord, profileID string) (*domain.CodexLaunchContext, error) {
	profileID = strings.TrimSpace(profileID)
	if rec.CodexProfileBinding != nil {
		if profileID != "" && profileID != rec.CodexProfileBinding.ProfileID {
			return nil, apierr.Conflict("CODEX_PROFILE_BINDING_CONFLICT", "This session is already bound to a different Codex profile", map[string]any{"profileId": rec.CodexProfileBinding.ProfileID})
		}
		return m.codexLaunchForRecord(ctx, rec)
	}
	if m.codexProfiles == nil {
		if profileID != "" || rec.CodexProfileBinding != nil {
			return nil, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile-bound launches are unavailable")
		}
		return nil, nil
	}
	if profileID == "" {
		profileID = "existing"
	}
	resolved, err := m.codexProfiles.ResolveCodexProfileForLaunch(ctx, profileID)
	if err != nil {
		return nil, err
	}
	resolved.Binding.SessionID = rec.ID
	resolved.Binding.CreatedAt = m.clock()
	bound, err := m.persistCodexBinding(ctx, resolved.Binding)
	if err != nil {
		return nil, err
	}
	rec.CodexProfileBinding = &bound
	resolved.Binding = bound
	return &resolved, nil
}

func (m *Manager) persistCodexBinding(ctx context.Context, requested domain.CodexSessionBinding) (domain.CodexSessionBinding, error) {
	writer, ok := m.store.(codexBindingWriter)
	if !ok {
		return domain.CodexSessionBinding{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile binding storage is unavailable")
	}
	bound, _, err := writer.BindCodexSessionProfile(ctx, requested)
	if err != nil {
		if errors.Is(err, domain.ErrCodexProfileBindingConflict) {
			return domain.CodexSessionBinding{}, apierr.Conflict("CODEX_PROFILE_BINDING_CONFLICT", "This session is already bound to a different Codex profile", nil)
		}
		return domain.CodexSessionBinding{}, err
	}
	if bound.ProfileID != requested.ProfileID || bound.Source != requested.Source || bound.Home != requested.Home {
		return domain.CodexSessionBinding{}, apierr.Conflict("CODEX_PROFILE_BINDING_CONFLICT", "This session is already bound to a different Codex profile", map[string]any{"profileId": bound.ProfileID})
	}
	return bound, nil
}

func (m *Manager) applyCodexLaunchEnvironment(id domain.SessionID, env map[string]string, launch domain.CodexLaunchContext) {
	boundHome := strings.TrimSpace(launch.Env["CODEX_HOME"])
	if boundHome == "" {
		boundHome = launch.Binding.Home
	}
	if configured := strings.TrimSpace(env["CODEX_HOME"]); configured != "" && configured != boundHome {
		m.logger.Warn("project Codex home overridden by immutable session profile binding", "sessionID", id, "profile_id", launch.Binding.ProfileID, "source", launch.Binding.Source)
	}
	env["CODEX_HOME"] = boundHome
}

func (m *Manager) invalidateCodexAuthenticationAfterFailure(rec domain.SessionRecord, err error) {
	if m.codexProfiles == nil || rec.CodexProfileBinding == nil || !errors.Is(err, ports.ErrChatAuthRequired) {
		return
	}
	m.codexProfiles.InvalidateCodexProfileAuthentication(rec.CodexProfileBinding.ProfileID)
}

func isolateManagedCodexCommand(argv []string, managed bool) []string {
	if !managed || len(argv) == 0 {
		return argv
	}
	index := 0
	if filepath.Base(argv[0]) == "env" {
		index = 1
		for index < len(argv) && strings.Contains(argv[index], "=") {
			index++
		}
	}
	if index >= len(argv) || filepath.Base(argv[index]) != "codex" {
		return argv
	}
	for i := index + 1; i+1 < len(argv); i++ {
		if argv[i] == "-c" && argv[i+1] == `cli_auth_credentials_store="file"` {
			return argv
		}
	}
	out := make([]string, 0, len(argv)+2)
	out = append(out, argv[:index+1]...)
	out = append(out, "-c", `cli_auth_credentials_store="file"`)
	out = append(out, argv[index+1:]...)
	return out
}
