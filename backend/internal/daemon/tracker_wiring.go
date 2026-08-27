package daemon

import (
	"errors"
	"log/slog"
	"strings"

	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	trackergithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/github"
	trackergitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/gitlab"
	trackermulti "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/multi"
	trackeronedev "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/onedev"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newGitHubTracker() (ports.Tracker, error) {
	return trackergithub.New(trackergithub.Options{Token: trackergithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}}})
}

// newGitLabTracker constructs a host-aware GitLab tracker. AllowedHosts and
// HostTokens from GitLabConfig are passed through so the tracker can route
// self-managed GitLab issue lookups to the correct host with the correct
// token. This mirrors the SCM provider's wiring in newGitLabSCMProvider.
func newGitLabTracker(gitlabCfg config.GitLabConfig) (ports.Tracker, error) {
	hostTokens := make(map[string]scmgitlab.TokenSource, len(gitlabCfg.HostTokens))
	for host, token := range gitlabCfg.HostTokens {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			hostTokens[host] = scmgitlab.StaticTokenSource(token)
		}
	}
	return trackergitlab.New(trackergitlab.Options{
		Token:        trackergitlab.DefaultTokenSource(),
		AllowedHosts: gitlabCfg.AllowedHosts,
		HostTokens:   hostTokens,
	})
}

// newOneDevTracker constructs a host-aware OneDev tracker from the same
// OneDevConfig the SCM provider uses, plus the two issue-specific knobs.
//
// OneDev has no public instance, so an operator who has not set
// AO_ONEDEV_ALLOWED_HOSTS has no OneDev to read issues from. That is the
// common case and the tracker reports it as ErrNoAllowedHosts, which the
// caller logs and steps over exactly as it does a missing GitHub or GitLab
// token — an unconfigured OneDev never disables the other trackers.
//
// A malformed AO_ONEDEV_ISSUE_STATES value is a different thing entirely: it
// is a configuration error, and it disables the OneDev tracker with an error
// naming the offending state rather than silently falling back to defaults
// the operator explicitly overrode.
func newOneDevTracker(onedevCfg config.OneDevConfig) (ports.Tracker, error) {
	states, err := trackeronedev.NewStateMap(onedevCfg.IssueStates)
	if err != nil {
		return nil, err
	}
	hostTokens := make(map[string]trackeronedev.TokenSource, len(onedevCfg.HostTokens))
	for host, token := range onedevCfg.HostTokens {
		hostTokens[host] = trackeronedev.StaticTokenSource(token)
	}
	return trackeronedev.New(trackeronedev.Options{
		Token:         trackeronedev.DefaultTokenSource(onedevCfg.Token),
		AllowedHosts:  onedevCfg.AllowedHosts,
		HostTokens:    hostTokens,
		States:        states,
		AssigneeField: onedevCfg.IssueAssigneeField,
	})
}

// trackerSubTrackers builds every configured tracker adapter, in a stable
// order.
//
// Every multi-tracker consumer goes through here for the same reason
// scmSubProviders exists on the SCM side: OneDev shipped registered in the SCM
// observer but missing from two of the three constructors, which surfaced live
// as `ao session claim-pr` failing on a OneDev pull request. Adding a tracker
// provider is one edit here, not one per call site.
//
// A tracker whose credentials or configuration are missing is reported to
// onDisabled (which may be nil) and omitted; it never blocks the others.
func trackerSubTrackers(gitlabCfg config.GitLabConfig, onedevCfg config.OneDevConfig, onDisabled func(key string, err error)) []trackermulti.NamedTracker {
	disabled := func(key string, err error) {
		if onDisabled != nil {
			onDisabled(key, err)
		}
	}

	var named []trackermulti.NamedTracker
	if t, err := newGitHubTracker(); err != nil {
		disabled(string(domain.TrackerProviderGitHub), err)
	} else {
		named = append(named, trackermulti.NamedTracker{Key: string(domain.TrackerProviderGitHub), Tracker: t})
	}
	if t, err := newGitLabTracker(gitlabCfg); err != nil {
		disabled(string(domain.TrackerProviderGitLab), err)
	} else {
		named = append(named, trackermulti.NamedTracker{Key: string(domain.TrackerProviderGitLab), Tracker: t})
	}
	if t, err := newOneDevTracker(onedevCfg); err != nil {
		disabled(string(domain.TrackerProviderOneDev), err)
	} else {
		named = append(named, trackermulti.NamedTracker{Key: string(domain.TrackerProviderOneDev), Tracker: t})
	}
	return named
}

// newMultiTracker builds a multi-tracker dispatching to the GitHub, GitLab and
// OneDev sub-trackers. When one tracker fails to construct (missing token, or
// no OneDev instance configured), the others still serve issue lookups — the
// same degrade-gracefully pattern used by newMultiSCMProvider. Returns nil when
// no tracker is usable; callers must tolerate a nil ports.Tracker (the session
// service's nil-guard handles this).
func newMultiTracker(gitlabCfg config.GitLabConfig, onedevCfg config.OneDevConfig, logger *slog.Logger) ports.Tracker {
	named := trackerSubTrackers(gitlabCfg, onedevCfg, func(key string, err error) {
		logTrackerDisabled(logger, key, err)
	})
	if len(named) == 0 {
		return nil
	}
	return trackermulti.New(named...)
}

func logTrackerDisabled(logger *slog.Logger, provider string, err error) {
	switch {
	case errors.Is(err, trackergithub.ErrNoToken) || errors.Is(err, trackergitlab.ErrNoToken) ||
		errors.Is(err, trackeronedev.ErrNoToken):
		logger.Warn("tracker disabled: no usable token", "provider", provider, "err", err)
	case errors.Is(err, trackeronedev.ErrNoAllowedHosts):
		// Not a misconfiguration: OneDev has no public instance, so a
		// deployment that does not use OneDev simply never sets the allowlist.
		logger.Debug("tracker disabled: no hosts configured", "provider", provider, "err", err)
	default:
		logger.Warn("tracker disabled: setup failed", "provider", provider, "err", err)
	}
}
