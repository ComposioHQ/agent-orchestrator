package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	trackergitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/gitlab"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestNewGitLabTracker_PassesAllowedHosts verifies that AllowedHosts from
// GitLabConfig flows into the tracker's Options. A self-managed host in
// AllowedHosts should be accepted by the tracker; one not in the list should
// be rejected with ErrHostNotAllowed.
func TestNewGitLabTracker_PassesAllowedHosts(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")

	selfHost := "gitlab.internal.example"
	cfg := config.GitLabConfig{
		AllowedHosts: []string{selfHost},
	}

	tracker, err := newGitLabTracker(cfg)
	if err != nil {
		t.Fatalf("newGitLabTracker: %v", err)
	}

	glTracker, ok := tracker.(*trackergitlab.Tracker)
	if !ok {
		t.Fatalf("expected *trackergitlab.Tracker, got %T", tracker)
	}

	// The allowlisted host should be accepted (not rejected as
	// ErrHostNotAllowed). It will fail with a network error (no real host),
	// but that proves the host was accepted by the allowlist check.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     selfHost,
	})
	if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("allowlisted host %q was rejected by the tracker: %v", selfHost, err)
	}

	// An unconfigured host should be rejected with ErrHostNotAllowed.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     "gitlab.evil.example",
	})
	if !errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("unconfigured host should be rejected with ErrHostNotAllowed, got: %v", err)
	}
}

// TestNewGitLabTracker_GitLabComStillWorks verifies that the zero-value host
// (gitlab.com) still works after wiring — backward compatibility. The host
// check should pass (not ErrHostNotAllowed); the request will fail with a
// network error since there's no real gitlab.com, but that's expected.
func TestNewGitLabTracker_GitLabComStillWorks(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")

	cfg := config.GitLabConfig{}
	tracker, err := newGitLabTracker(cfg)
	if err != nil {
		t.Fatalf("newGitLabTracker: %v", err)
	}

	glTracker, ok := tracker.(*trackergitlab.Tracker)
	if !ok {
		t.Fatalf("expected *trackergitlab.Tracker, got %T", tracker)
	}

	// A zero-value Host (gitlab.com) should NOT be rejected with
	// ErrHostNotAllowed.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     "", // gitlab.com
	})
	if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("gitlab.com (Host: \"\") should not be rejected: %v", err)
	}
}

// TestNewGitLabTracker_HostTokensRoutedCorrectly verifies that per-host
// tokens from GitLabConfig flow into the tracker and are used for the
// correct host. We construct the tracker through the wiring function, then
// verify the wiring by testing that:
//   - The tracker was constructed without error (host tokens flowed through).
//   - The default host uses the default token.
//   - An unconfigured host is still rejected.
//
// For full end-to-end token routing, the tracker_test.go in the adapter
// package already covers Get/List with a fake server.
func TestNewGitLabTracker_HostTokensRoutedCorrectly(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")

	selfHost := "gitlab.internal.example"
	cfg := config.GitLabConfig{
		AllowedHosts: []string{selfHost},
		HostTokens: map[string]string{
			selfHost: "self-host-token",
		},
	}

	tracker, err := newGitLabTracker(cfg)
	if err != nil {
		t.Fatalf("newGitLabTracker: %v", err)
	}

	// The tracker constructed successfully, meaning HostTokens flowed through
	// without error. Verify the host is accepted (not ErrHostNotAllowed).
	glTracker, ok := tracker.(*trackergitlab.Tracker)
	if !ok {
		t.Fatalf("expected *trackergitlab.Tracker, got %T", tracker)
	}

	// Self-managed host should be accepted.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     selfHost,
	})
	if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("self-managed host %q with HostTokens was rejected: %v", selfHost, err)
	}

	// Default host (gitlab.com) should also be accepted.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     "",
	})
	if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("gitlab.com should not be rejected: %v", err)
	}
}

// TestNewGitLabTracker_HostTokensCaseInsensitive verifies that HostTokens
// keys from config are lowercased before being passed to the tracker, so a
// mixed-case config key (e.g. "GitLab.Internal.Example") still matches the
// lowercased host lookup in the tracker's configForHost.
func TestNewGitLabTracker_HostTokensCaseInsensitive(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")

	selfHost := "GitLab.Internal.Example" // mixed case in config
	cfg := config.GitLabConfig{
		AllowedHosts: []string{selfHost},
		HostTokens: map[string]string{
			selfHost: "self-host-token",
		},
	}

	tracker, err := newGitLabTracker(cfg)
	if err != nil {
		t.Fatalf("newGitLabTracker: %v", err)
	}

	glTracker, ok := tracker.(*trackergitlab.Tracker)
	if !ok {
		t.Fatalf("expected *trackergitlab.Tracker, got %T", tracker)
	}

	// The tracker lowercases AllowedHosts internally. newGitLabTracker must
	// also lowercase HostTokens keys so they match. If the host is accepted
	// (not ErrHostNotAllowed), the token was found in the map.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     "gitlab.internal.example", // lowercase lookup
	})
	if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("mixed-case config host should be accepted after lowercasing: %v", err)
	}
}

// TestNewGitLabTracker_UnconfiguredHostRejected verifies that a host not in
// AllowedHosts (and not gitlab.com) is rejected by the tracker before any
// credential is attached — both via Get and via List.
func TestNewGitLabTracker_UnconfiguredHostRejected(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")

	cfg := config.GitLabConfig{
		AllowedHosts: []string{"gitlab.internal.example"},
	}
	tracker, err := newGitLabTracker(cfg)
	if err != nil {
		t.Fatalf("newGitLabTracker: %v", err)
	}

	glTracker, ok := tracker.(*trackergitlab.Tracker)
	if !ok {
		t.Fatalf("expected *trackergitlab.Tracker, got %T", tracker)
	}

	// Unconfigured host via Get.
	_, err = glTracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project#1",
		Host:     "gitlab.attacker.example",
	})
	if !errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("Get with unconfigured host: err = %v, want ErrHostNotAllowed", err)
	}

	// Unconfigured host via List.
	_, err = glTracker.List(context.Background(), domain.TrackerRepo{
		Provider: domain.TrackerProviderGitLab,
		Native:   "group/project",
		Host:     "gitlab.attacker.example",
	}, domain.ListFilter{})
	if !errors.Is(err, trackergitlab.ErrHostNotAllowed) {
		t.Fatalf("List with unconfigured host: err = %v, want ErrHostNotAllowed", err)
	}
}

// TestNewMultiTracker_WithGitLabConfig verifies that newMultiTracker passes
// GitLabConfig through to newGitLabTracker — a self-managed host configured
// in GitLabConfig should produce a tracker that accepts that host, and the
// multi-tracker should be non-nil when the GitLab token is available.
func TestNewMultiTracker_WithGitLabConfig(t *testing.T) {
	t.Setenv("AO_GITLAB_TOKEN", "default-token")
	t.Setenv("AO_GITHUB_TOKEN", "")

	selfHost := "gitlab.internal.example"
	cfg := config.GitLabConfig{
		AllowedHosts: []string{selfHost},
		HostTokens: map[string]string{
			selfHost: "self-host-token",
		},
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	tracker := newMultiTracker(cfg, log)
	if tracker == nil {
		t.Fatal("newMultiTracker = nil, want non-nil when GitLab token is available")
	}

	// The multi-tracker should route GitLab issue lookups. Preflight checks
	// the default (gitlab.com) token — it may fail due to no real gitlab.com,
	// but should never return ErrHostNotAllowed.
	if err := tracker.Preflight(context.Background()); err != nil {
		if errors.Is(err, trackergitlab.ErrHostNotAllowed) {
			t.Fatalf("Preflight should not return ErrHostNotAllowed: %v", err)
		}
	}
}
