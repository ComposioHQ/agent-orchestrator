package daemon

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	trackeronedev "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/onedev"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestIntakeResolverResolvesEveryRegisteredProvider is the guard the SCM side
// went without: it shipped with only one of three constructors covered, and
// that gap reached a live daemon. Intake resolves per project config, so every
// provider a project may name must come back with an adapter.
func TestIntakeResolverResolvesEveryRegisteredProvider(t *testing.T) {
	gitlabCfg, onedevCfg := fullyConfiguredTrackerEnv(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(gitlabCfg, onedevCfg, log)

	for _, provider := range allTrackerProviders {
		tracker, err := resolver.Resolve(provider)
		if err != nil {
			t.Errorf("Resolve(%s) = %v, want an adapter", provider, err)
			continue
		}
		if tracker == nil {
			t.Errorf("Resolve(%s) returned a nil adapter", provider)
		}
	}
}

// TestIntakeResolverDefaultsToGitHub pins the back-compatible default: a
// project config written before Provider existed carries an empty provider and
// must keep resolving to GitHub, matching TrackerIntakeConfig.WithDefaults.
func TestIntakeResolverDefaultsToGitHub(t *testing.T) {
	t.Setenv("AO_GITHUB_TOKEN", "gh-test-token")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(config.GitLabConfig{}, config.OneDevConfig{}, log)

	tracker, err := resolver.Resolve("")
	if err != nil {
		t.Fatalf("Resolve(\"\") = %v, want the GitHub adapter", err)
	}
	if tracker == nil {
		t.Fatal("Resolve(\"\") returned a nil adapter")
	}
}

// TestIntakeResolverRejectsUnknownProvider keeps a project configured for a
// tracker AO has no adapter for from silently reaching a dispatcher that would
// fail one call later with a less useful message.
func TestIntakeResolverRejectsUnknownProvider(t *testing.T) {
	t.Setenv("AO_GITHUB_TOKEN", "gh-test-token")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(config.GitLabConfig{}, config.OneDevConfig{}, log)

	_, err := resolver.Resolve(domain.TrackerProvider("linear"))
	if err == nil {
		t.Fatal("Resolve(linear) = nil error, want no-adapter")
	}
	if !strings.Contains(err.Error(), "linear") {
		t.Errorf("error %q does not name the requested provider", err)
	}
}

// TestIntakeResolverOmitsUnconfiguredOneDev pins the degrade-gracefully path:
// with no OneDev instance configured — the common case, since OneDev has no
// public instance — OneDev must be absent while GitHub still resolves.
func TestIntakeResolverOmitsUnconfiguredOneDev(t *testing.T) {
	t.Setenv("AO_GITHUB_TOKEN", "gh-test-token")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(config.GitLabConfig{}, config.OneDevConfig{}, log)

	if _, err := resolver.Resolve(domain.TrackerProviderOneDev); err == nil {
		t.Error("Resolve(onedev) with no instance configured = nil error, want no-adapter")
	}
	if _, err := resolver.Resolve(domain.TrackerProviderGitHub); err != nil {
		t.Errorf("Resolve(github) = %v; an unconfigured OneDev must not disable GitHub intake", err)
	}
}

// TestIntakeResolverIsLazy pins intake's contract that daemon readiness never
// waits on a credential helper: nothing is constructed until the first Resolve.
func TestIntakeResolverIsLazy(t *testing.T) {
	gitlabCfg, onedevCfg := fullyConfiguredTrackerEnv(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(gitlabCfg, onedevCfg, log)

	if resolver.adapter != nil {
		t.Fatal("newIntakeTrackerResolver built its adapters eagerly")
	}
	if _, err := resolver.Resolve(domain.TrackerProviderGitHub); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if resolver.adapter == nil {
		t.Fatal("Resolve did not build the dispatcher")
	}
}

// TestIntakeResolvedOneDevTrackerCarriesTheConfiguredStateMap proves the
// configuration reaches the adapter intake actually uses, not just the one the
// session service gets.
func TestIntakeResolvedOneDevTrackerCarriesTheConfiguredStateMap(t *testing.T) {
	_, onedevCfg := fullyConfiguredTrackerEnv(t)
	onedevCfg.IssueStates = map[string]string{"Blocked": "stuck"}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := newIntakeTrackerResolver(config.GitLabConfig{}, onedevCfg, log)
	if _, err := resolver.Resolve(domain.TrackerProviderOneDev); err == nil {
		t.Fatal("Resolve(onedev) = nil error; a malformed state mapping must disable the tracker")
	}

	onedevCfg.IssueStates = map[string]string{"Blocked": "in_progress"}
	resolver = newIntakeTrackerResolver(config.GitLabConfig{}, onedevCfg, log)
	tracker, err := resolver.Resolve(domain.TrackerProviderOneDev)
	if err != nil {
		t.Fatalf("Resolve(onedev) = %v", err)
	}
	// The dispatcher must route a OneDev id to the OneDev adapter, which
	// rejects an unallowlisted host locally — no network I/O.
	_, err = tracker.Get(context.Background(), domain.TrackerID{
		Provider: domain.TrackerProviderOneDev, Native: "productone#1", Host: "onedev.attacker.example",
	})
	if err == nil || !strings.Contains(err.Error(), "not in allowlist") {
		t.Errorf("Get through the intake dispatcher = %v, want %v", err, trackeronedev.ErrHostNotAllowed)
	}
}
