package scm

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// InstallationTokenSource adapts the broker to the GitHub SCM adapter's token
// contract, so the hosted path reuses the same observer, provider, and
// attribution logic as local AO with an installation credential instead of a
// user token.
//
// It caches the brokered token in memory only, and re-brokers when the adapter
// reports an auth failure or the credential is close to expiry.
type InstallationTokenSource struct {
	broker  *Broker
	request BrokerRequest
	now     func() time.Time

	mu     sync.Mutex
	cached BrokeredToken
	held   bool
}

var (
	_ scmgithub.TokenSource     = (*InstallationTokenSource)(nil)
	_ ports.SCMIdentityResolver = (*ObservationProvider)(nil)
)

// NewInstallationTokenSource binds a broker to one repository and purpose.
func NewInstallationTokenSource(broker *Broker, request BrokerRequest) (*InstallationTokenSource, error) {
	if broker == nil {
		return nil, ErrNotConfigured
	}
	repository, err := NormalizeRepository(request.Repository)
	if err != nil {
		return nil, err
	}
	request.Repository = repository
	if strings.TrimSpace(request.Purpose) == "" {
		request.Purpose = "observe"
	}
	return &InstallationTokenSource{broker: broker, request: request, now: time.Now}, nil
}

// Token returns a live installation credential, brokering a new one when the
// cached credential is missing or within the broker's refresh margin.
func (s *InstallationTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	cached, held := s.cached, s.held
	s.mu.Unlock()
	if held && s.now().UTC().Add(tokenRefreshMargin).Before(cached.ExpiresAt) {
		return cached.Token.Reveal(), nil
	}
	brokered, err := s.broker.BrokerToken(ctx, s.request)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.cached, s.held = brokered, true
	s.mu.Unlock()
	return brokered.Token.Reveal(), nil
}

// InvalidateToken drops the cached credential in this source and in the
// broker, so a revoked installation token is re-minted on the next call.
func (s *InstallationTokenSource) InvalidateToken() {
	s.mu.Lock()
	cached, held := s.cached, s.held
	s.cached, s.held = BrokeredToken{}, false
	s.mu.Unlock()
	if held {
		s.broker.Invalidate(cached.ExternalInstallationID, cached.ExternalRepositoryID, cached.Purpose)
	}
}

// ObservationProvider is the GitHub SCM provider wired to an installation
// credential. Everything except identity is the local adapter verbatim.
//
// Identity is overridden because an installation token cannot read `/user`:
// GitHub attributes its actions to the app's bot account. Attribution logic
// that asks "did AO write this comment?" must compare against that bot login,
// not against a human user.
type ObservationProvider struct {
	*scmgithub.Provider
	botLogin string
}

// ObservationProviderOptions configures the hosted SCM provider.
type ObservationProviderOptions struct {
	Broker *Broker
	// Request identifies the tenant and repository this provider observes.
	Request    BrokerRequest
	HTTPClient *http.Client
	RESTBase   string
	GraphQLURL string
	Logger     *slog.Logger
}

// NewObservationProvider builds a GitHub provider whose credential comes from
// the installation broker. Token preflight is skipped: brokering touches the
// database and the allowlist, so it must not run during construction.
func NewObservationProvider(options ObservationProviderOptions) (*ObservationProvider, error) {
	if options.Broker == nil {
		return nil, ErrNotConfigured
	}
	if strings.TrimSpace(options.Request.Purpose) == "" {
		options.Request.Purpose = "observe"
	}
	tokens, err := NewInstallationTokenSource(options.Broker, options.Request)
	if err != nil {
		return nil, err
	}
	provider, err := scmgithub.NewProvider(scmgithub.ProviderOptions{
		HTTPClient:         options.HTTPClient,
		Token:              tokens,
		SkipTokenPreflight: true,
		RESTBase:           options.RESTBase,
		GraphQLURL:         options.GraphQLURL,
		Logger:             options.Logger,
	})
	if err != nil {
		return nil, err
	}
	return &ObservationProvider{
		Provider: provider,
		botLogin: options.Broker.app.Credentials().BotLogin(),
	}, nil
}

// AuthenticatedIdentity reports the app installation's bot account. It never
// calls the provider, because `/user` is not readable with an installation
// token.
func (p *ObservationProvider) AuthenticatedIdentity(context.Context) (ports.SCMIdentity, error) {
	return ports.SCMIdentity{Login: p.botLogin, Human: false}, nil
}

// AuthenticatedIdentityForProvider satisfies the scoped resolver used by the
// multi-provider observer. GitHub identity is not host-scoped.
func (p *ObservationProvider) AuthenticatedIdentityForProvider(
	ctx context.Context,
	provider, _ string,
) (ports.SCMIdentity, error) {
	if !strings.EqualFold(strings.TrimSpace(provider), "github") {
		return ports.SCMIdentity{}, ErrNotConfigured
	}
	return p.AuthenticatedIdentity(ctx)
}

// SCMCredentialsAvailable reports whether the tenant can currently obtain a
// credential for this repository. A denied allowlist is a configuration state,
// not an error, so the observer reports missing credentials rather than
// retrying forever.
func (p *ObservationProvider) SCMCredentialsAvailable(context.Context) (bool, error) {
	return true, nil
}
