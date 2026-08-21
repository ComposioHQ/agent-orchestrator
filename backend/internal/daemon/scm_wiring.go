package daemon

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	scmmulti "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/multi"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startSCMObserver wires the provider-neutral SCM observer with both GitHub
// and GitLab providers via a multi Provider dispatcher. Missing credentials
// for one provider do not prevent the other from starting; the observer is
// disabled only when no provider has usable credentials.
func startSCMObserver(ctx context.Context, store *sqlite.Store, lcm *lifecycle.Manager, gitlabCfg config.GitLabConfig, logger *slog.Logger) <-chan struct{} {
	var named []scmmulti.NamedProvider

	ghProvider, ghErr := newGitHubSCMProvider(logger)
	if ghErr != nil {
		logSCMProviderDisabled(logger, "github", ghErr)
	} else {
		named = append(named, scmmulti.NamedProvider{Key: "github", Provider: ghProvider})
	}

	glProvider, glErr := newGitLabSCMProvider(gitlabCfg, logger)
	if glErr != nil {
		logSCMProviderDisabled(logger, "gitlab", glErr)
	} else {
		named = append(named, scmmulti.NamedProvider{Key: "gitlab", Provider: glProvider})
	}

	if len(named) == 0 {
		logger.Warn("scm observer disabled: no usable SCM provider")
		return closedDone()
	}
	provider := scmmulti.New(named...)
	observer := scmobserve.New(provider, store, lcm, scmobserve.Config{Logger: logger, ScopedIdentityResolver: provider})
	return observer.Start(ctx)
}

func newGitHubSCMProvider(logger *slog.Logger) (*scmgithub.Provider, error) {
	tokens := scmgithub.FallbackTokenSource{
		scmgithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}},
		&scmgithub.GHTokenSource{},
	}
	return scmgithub.NewProvider(scmgithub.ProviderOptions{Token: tokens, SkipTokenPreflight: true, Logger: logger})
}

func newGitLabSCMProvider(gitlabCfg config.GitLabConfig, logger *slog.Logger) (*scmgitlab.Provider, error) {
	tokens := gitlabDotComTokenSource(gitlabCfg)
	hostTokens := gitlabHostTokenSources(gitlabCfg)
	return scmgitlab.NewProvider(scmgitlab.ProviderOptions{
		Token:              tokens,
		SkipTokenPreflight: true,
		Logger:             logger,
		AllowedHosts:       gitlabCfg.AllowedHosts,
		HostTokens:         hostTokens,
	})
}

// gitlabDotComTokenSource is the token chain for the default client
// (gitlab.com). The glab lookup is scoped to gitlab.com, and glab's own
// default host is consulted only when no self-managed instance is configured:
// an unscoped lookup on a multi-instance glab answers with whichever host it
// lists first, so keeping it would send a self-managed token to gitlab.com.
// `ao doctor` applies the same rule when it decides whether a credential is
// attributable to gitlab.com (checkGitLabTokens in cli/doctor.go), so the two
// agree on which token gitlab.com is probed and polled with.
func gitlabDotComTokenSource(gitlabCfg config.GitLabConfig) scmgitlab.TokenSource {
	return scmgitlab.DotComTokenSource(!hasSelfManagedGitLabHost(gitlabCfg))
}

// hasSelfManagedGitLabHost reports whether the allowlist names an instance
// other than gitlab.com. gitlab.com and its aliases are always allowed and are
// served by the default client, so they do not make the setup multi-instance.
func hasSelfManagedGitLabHost(gitlabCfg config.GitLabConfig) bool {
	for _, host := range gitlabCfg.AllowedHosts {
		if host = scmgitlab.NormalizeHost(host); host != "" && !scmgitlab.IsGitLabDotCom(host) {
			return true
		}
	}
	return false
}

// gitlabHostTokenSources maps every allowlisted self-managed host to the token
// source the provider should use for it: the explicit AO_GITLAB_HOST_TOKENS
// override when configured, otherwise a chain that asks glab for that host
// specifically. Without the per-host entry a multi-instance glab setup answers
// with whichever host it happens to list first.
//
// An entry with an empty token (`host=` in AO_GITLAB_HOST_TOKENS, which
// config.Load preserves) is not an override: binding it would leave the host
// with a token source that can only ever fail, silently disabling it. Such an
// entry falls through to the host chain instead.
func gitlabHostTokenSources(gitlabCfg config.GitLabConfig) map[string]scmgitlab.TokenSource {
	hostTokens := make(map[string]scmgitlab.TokenSource, len(gitlabCfg.HostTokens)+len(gitlabCfg.AllowedHosts))
	for _, host := range gitlabCfg.AllowedHosts {
		if host = scmgitlab.NormalizeHost(host); host != "" {
			hostTokens[host] = scmgitlab.HostTokenSource(host)
		}
	}
	for host, token := range gitlabCfg.HostTokens {
		host = scmgitlab.NormalizeHost(host)
		if host == "" || strings.TrimSpace(token) == "" {
			continue
		}
		hostTokens[host] = scmgitlab.StaticTokenSource(token)
	}
	return hostTokens
}

func logSCMProviderDisabled(logger *slog.Logger, provider string, err error) {
	if errors.Is(err, scmgithub.ErrNoToken) || errors.Is(err, scmgithub.ErrAuthFailed) ||
		errors.Is(err, scmgitlab.ErrNoToken) || errors.Is(err, scmgitlab.ErrAuthFailed) {
		logger.Warn("scm provider disabled: no usable token", "provider", provider, "err", err)
	} else {
		logger.Warn("scm provider disabled: setup failed", "provider", provider, "err", err)
	}
}

// newMultiSCMProvider builds a multi-provider for use outside the polling
// observer (e.g. session service PR claiming). Returns nil when no provider
// has usable credentials — callers must tolerate a nil SCM.
func newMultiSCMProvider(gitlabCfg config.GitLabConfig, logger *slog.Logger) *scmmulti.Provider {
	var named []scmmulti.NamedProvider
	if gh, err := newGitHubSCMProvider(logger); err == nil {
		named = append(named, scmmulti.NamedProvider{Key: "github", Provider: gh})
	}
	if gl, err := newGitLabSCMProvider(gitlabCfg, logger); err == nil {
		named = append(named, scmmulti.NamedProvider{Key: "gitlab", Provider: gl})
	}
	if len(named) == 0 {
		return nil
	}
	return scmmulti.New(named...)
}

// newMultiSCMMerger builds a multi-merger for PR merge actions, registering
// both GitHub and GitLab providers. When one provider is unavailable (missing
// token), the multi-merger still routes to the healthy one — same
// degrade-gracefully pattern as newMultiSCMProvider. Returns nil when no
// provider has usable credentials.
func newMultiSCMMerger(gitlabCfg config.GitLabConfig, logger *slog.Logger) *scmmulti.Merger {
	var named []scmmulti.NamedMerger
	if gh, err := newGitHubSCMProvider(logger); err == nil {
		named = append(named, scmmulti.NamedMerger{Key: "github", Merger: gh})
	}
	if gl, err := newGitLabSCMProvider(gitlabCfg, logger); err == nil {
		named = append(named, scmmulti.NamedMerger{Key: "gitlab", Merger: gl})
	}
	if len(named) == 0 {
		return nil
	}
	return scmmulti.NewMerger(named...)
}

func closedDone() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
