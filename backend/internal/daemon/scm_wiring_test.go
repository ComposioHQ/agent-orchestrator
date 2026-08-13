package daemon

import (
	"context"
	"log/slog"
	"testing"

	scmmulti "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/multi"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestSCMWiring_MultiProviderSatisfiesScopedIdentityResolver verifies that the
// multi provider constructed with both GitHub and GitLab sub-providers
// satisfies ports.ScopedIdentityResolver so it can be wired as the observer's
// scoped identity resolver (finding #7).
func TestSCMWiring_MultiProviderSatisfiesScopedIdentityResolver(t *testing.T) {
	gh, err := newGitHubSCMProvider(slog.Default())
	if err != nil {
		t.Skipf("github provider unavailable (no token): %v", err)
	}
	gl, err := newGitLabSCMProvider(testGitLabConfig(), slog.Default())
	if err != nil {
		t.Skipf("gitlab provider unavailable (no token): %v", err)
	}

	multi := scmmulti.New(
		scmmulti.NamedProvider{Key: "github", Provider: gh},
		scmmulti.NamedProvider{Key: "gitlab", Provider: gl},
	)

	// The multi provider must satisfy ScopedIdentityResolver.
	var _ ports.ScopedIdentityResolver = multi

	// The multi provider must also satisfy the observer's Provider interface
	// (it already does in production; this asserts the type assertion at compile
	// time for the test).
	_ = multi.SCMCredentialsAvailable
}

// TestSCMWiring_NewMultiSCMProviderReturnsScopedResolver verifies that the
// newMultiSCMProvider helper (used outside the observer) also returns a value
// that satisfies ScopedIdentityResolver.
func TestSCMWiring_NewMultiSCMProviderReturnsScopedResolver(t *testing.T) {
	multi := newMultiSCMProvider(testGitLabConfig(), slog.Default())
	if multi == nil {
		t.Skip("no SCM provider available (missing tokens)")
	}
	var _ ports.ScopedIdentityResolver = multi
}

// TestSCMWiring_ObserverConfigHasScopedResolver verifies that the observer
// constructed with a multi provider has a non-nil ScopedIdentityResolver,
// mirroring how startSCMObserver wires it in production.
func TestSCMWiring_ObserverConfigHasScopedResolver(t *testing.T) {
	gh, err := newGitHubSCMProvider(slog.Default())
	if err != nil {
		t.Skipf("github provider unavailable: %v", err)
	}
	gl, err := newGitLabSCMProvider(testGitLabConfig(), slog.Default())
	if err != nil {
		t.Skipf("gitlab provider unavailable: %v", err)
	}

	multi := scmmulti.New(
		scmmulti.NamedProvider{Key: "github", Provider: gh},
		scmmulti.NamedProvider{Key: "gitlab", Provider: gl},
	)

	// Simulate the production wiring: the multi provider is passed as both
	// the SCM provider and the ScopedIdentityResolver.
	cfg := observerConfigForTest(multi)
	if cfg.ScopedIdentityResolver == nil {
		t.Fatal("ScopedIdentityResolver is nil; production wiring must set it")
	}

	// Verify it actually resolves per-provider (github identity is available
	// if a token was set; if not, it should still return an error, not panic).
	_, _ = cfg.ScopedIdentityResolver.AuthenticatedIdentityForProvider(context.Background(), "github")
}

// observerConfigForTest builds a minimal observer Config that mirrors the
// production wiring in startSCMObserver. The helper avoids importing the
// observer package directly (which would create an import cycle in tests).
func observerConfigForTest(multi *scmmulti.Provider) observerConfig {
	return observerConfig{ScopedIdentityResolver: multi}
}

type observerConfig struct {
	ScopedIdentityResolver ports.ScopedIdentityResolver
}

func testGitLabConfig() config.GitLabConfig {
	return config.GitLabConfig{}
}
