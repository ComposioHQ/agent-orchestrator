package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	trackergithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/github"
	trackermulti "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/multi"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	trackerintake "github.com/aoagents/agent-orchestrator/backend/internal/observe/trackerintake"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startTrackerIntake wires the opt-in issue-intake loop. The observer always
// runs — Poll re-reads each project's config on every tick and skips projects
// with intake disabled, so a project enabling intake after daemon boot is
// picked up on the next tick without a restart. The adapters stay lazy so
// daemon readiness is not blocked by credential probing or a gh CLI call, and
// no credential is resolved until some enabled project is actually polled.
func startTrackerIntake(ctx context.Context, store *sqlite.Store, sessions *sessionsvc.Service, gitlabCfg config.GitLabConfig, onedevCfg config.OneDevConfig, logger *slog.Logger) <-chan struct{} {
	resolver := newIntakeTrackerResolver(gitlabCfg, onedevCfg, logger)
	observer := trackerintake.New(resolver, store, sessions, trackerintake.Config{Logger: logger})
	return observer.Start(ctx)
}

// ---------------------------------------------------------------------------
// Multi-provider resolution
// ---------------------------------------------------------------------------

// intakeTrackerResolver resolves a project's configured tracker provider to an
// adapter, dispatching through a trackermulti.Tracker registered with every
// provider AO ships an adapter for.
//
// Intake used to be pinned to GitHub through a SingleTrackerResolver, which
// meant a GitLab project could have its merge requests observed but not its
// issues ingested, and a OneDev project could do neither. The resolver keeps
// the set of registered keys alongside the dispatcher so an unregistered
// provider is reported as "no adapter" at resolve time — where the observer
// logs the project and provider — rather than as an opaque list failure one
// call later.
//
// Construction is deferred to the first Resolve, preserving intake's contract
// that daemon readiness never waits on a credential helper. GitHub keeps its
// own lazy adapter (below) because its credential may come from `gh auth
// token`, which must stay retryable rather than being resolved once at build
// time.
type intakeTrackerResolver struct {
	gitlabCfg config.GitLabConfig
	onedevCfg config.OneDevConfig
	logger    *slog.Logger

	mu        sync.Mutex
	adapter   ports.Tracker
	providers map[domain.TrackerProvider]bool
}

func newIntakeTrackerResolver(gitlabCfg config.GitLabConfig, onedevCfg config.OneDevConfig, logger *slog.Logger) *intakeTrackerResolver {
	return &intakeTrackerResolver{gitlabCfg: gitlabCfg, onedevCfg: onedevCfg, logger: logger}
}

// Resolve returns the multi-tracker when the provider has a registered
// adapter. An empty provider means GitHub, matching
// domain.TrackerIntakeConfig.WithDefaults.
func (r *intakeTrackerResolver) Resolve(provider domain.TrackerProvider) (ports.Tracker, error) {
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.adapter == nil {
		r.build()
	}
	if !r.providers[provider] {
		return nil, fmt.Errorf("tracker intake: no adapter for provider %q", provider)
	}
	return r.adapter, nil
}

// build registers every configured tracker with a trackermulti dispatcher.
// GitHub's entry replaces the one trackerSubTrackers would supply, so intake
// keeps its gh-CLI credential fallback; the others come from the same helper
// the session-service multi-tracker uses, so the two cannot drift apart.
func (r *intakeTrackerResolver) build() {
	named := []trackermulti.NamedTracker{{
		Key:     string(domain.TrackerProviderGitHub),
		Tracker: newLazyGitHubTracker(r.logger),
	}}
	r.providers = map[domain.TrackerProvider]bool{domain.TrackerProviderGitHub: true}

	for _, sub := range trackerSubTrackers(r.gitlabCfg, r.onedevCfg, func(key string, err error) {
		logTrackerDisabled(r.logger, key, err)
	}) {
		if sub.Key == string(domain.TrackerProviderGitHub) {
			continue // intake uses its own lazy GitHub adapter
		}
		named = append(named, sub)
		r.providers[domain.TrackerProvider(sub.Key)] = true
	}
	r.adapter = trackermulti.New(named...)
}

// ---------------------------------------------------------------------------
// GitHub lazy adapter (token sourced from env or gh CLI fallback)
// ---------------------------------------------------------------------------

type lazyGitHubTracker struct {
	logger  *slog.Logger
	tokens  *trackerTokenSource
	mu      sync.Mutex
	tracker ports.Tracker
}

func newLazyGitHubTracker(logger *slog.Logger) *lazyGitHubTracker {
	return &lazyGitHubTracker{logger: logger, tokens: &trackerTokenSource{}}
}

func (t *lazyGitHubTracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return domain.Issue{}, err
	}
	return tracker.Get(ctx, id)
}

func (t *lazyGitHubTracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	tracker, err := t.resolve()
	if err != nil {
		return nil, err
	}
	return tracker.List(ctx, repo, filter)
}

func (t *lazyGitHubTracker) Preflight(ctx context.Context) error {
	tracker, err := t.resolve()
	if err != nil {
		return err
	}
	return tracker.Preflight(ctx)
}

func (t *lazyGitHubTracker) resolve() (ports.Tracker, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tracker != nil {
		return t.tracker, nil
	}
	tracker, err := trackergithub.New(trackergithub.Options{Token: t.tokens})
	if err != nil {
		if errors.Is(err, trackergithub.ErrNoToken) && t.logger != nil {
			t.logger.Warn("tracker intake disabled: no usable GitHub token", "err", err)
		}
		return nil, err
	}
	t.tracker = tracker
	return tracker, nil
}

const (
	trackerTokenCacheTTL       = 5 * time.Minute
	trackerTokenCommandTimeout = 5 * time.Second
)

// trackerTokenSource mirrors the SCM credential precedence while returning the
// tracker adapter's own ErrNoToken sentinel.
type trackerTokenSource struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (s *trackerTokenSource) Token(ctx context.Context) (string, error) {
	env := trackergithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}}
	if tok, err := env.Token(ctx); err == nil {
		return tok, nil
	} else if !errors.Is(err, trackergithub.ErrNoToken) {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.token != "" && now.Before(s.expiresAt) {
		return s.token, nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, trackerTokenCommandTimeout)
	defer cancel()
	out, err := aoprocess.CommandContext(cmdCtx, "gh", "auth", "token").Output()
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", trackergithub.ErrNoToken
	}
	s.token = token
	s.expiresAt = now.Add(trackerTokenCacheTTL)
	return token, nil
}
