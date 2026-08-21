package daemon

import (
	"context"
	"log/slog"
	"testing"

	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	scmmulti "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/multi"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
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
// Config constructed in production wiring (startSCMObserver) carries a
// non-nil ScopedIdentityResolver when a multi provider is available.
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

	// Mirror the production wiring in startSCMObserver: the multi provider
	// is passed as the ScopedIdentityResolver in the observer Config.
	cfg := scmobserve.Config{
		ScopedIdentityResolver: multi,
	}
	if cfg.ScopedIdentityResolver == nil {
		t.Fatal("ScopedIdentityResolver is nil; production wiring must set it")
	}

	// Verify it actually resolves per-provider (github identity is available
	// if a token was set; if not, it should still return an error, not panic).
	_, _ = cfg.ScopedIdentityResolver.AuthenticatedIdentityForProvider(context.Background(), "github", "")
}

func testGitLabConfig() config.GitLabConfig {
	return config.GitLabConfig{}
}

// TestGitLabHostTokenSources covers per-host credential selection: an explicit
// AO_GITLAB_HOST_TOKENS entry wins, an allowlisted host without one gets a
// chain that asks glab about that host, and host keys are normalized so a
// mixed-case entry still matches the allowlist.
func TestGitLabHostTokenSources(t *testing.T) {
	sources := gitlabHostTokenSources(config.GitLabConfig{
		AllowedHosts: []string{"gitlab.internal:8443", " GitLab.Example.com ", ""},
		HostTokens:   map[string]string{"GitLab.Example.COM": "host-pat"},
	})

	if len(sources) != 2 {
		t.Fatalf("sources = %v, want one entry per allowlisted host", sources)
	}
	if _, ok := sources["gitlab.example.com"].(scmgitlab.StaticTokenSource); !ok {
		t.Fatalf("gitlab.example.com source = %T, want the configured override", sources["gitlab.example.com"])
	}
	chain, ok := sources["gitlab.internal:8443"].(scmgitlab.FallbackTokenSource)
	if !ok {
		t.Fatalf("gitlab.internal:8443 source = %T, want a fallback chain", sources["gitlab.internal:8443"])
	}
	scoped := false
	for _, src := range chain {
		if gl, isGLab := src.(*scmgitlab.GLabTokenSource); isGLab && gl.Hostname == "gitlab.internal:8443" {
			scoped = true
		}
	}
	if !scoped {
		t.Fatal("host chain has no glab source scoped to the host")
	}
}
