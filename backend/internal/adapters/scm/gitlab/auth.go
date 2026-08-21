package gitlab

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// TokenSource yields a GitLab private token on demand. Production wires this
// to EnvTokenSource or GLabTokenSource; tests inject StaticTokenSource.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// tokenInvalidator is the optional capability of dropping a cached token so
// the next call re-fetches it. The Client invokes this whenever GitLab
// responds with an auth-class failure.
type tokenInvalidator interface {
	InvalidateToken()
}

// ErrNoToken is returned when no token source could yield a non-empty token.
var ErrNoToken = errors.New("gitlab scm: no token configured")

// ErrAuthFailed is returned when GitLab rejects the supplied token (401/403).
var ErrAuthFailed = errors.New("gitlab scm: authentication failed")

// StaticTokenSource is a literal token, typically used in tests.
type StaticTokenSource string

// Token returns the literal token value, trimmed of whitespace.
func (s StaticTokenSource) Token(context.Context) (string, error) {
	t := strings.TrimSpace(string(s))
	if t == "" {
		return "", ErrNoToken
	}
	return t, nil
}

// EnvTokenSource reads the first non-empty value from the listed env vars,
// falling back to GITLAB_TOKEN. Order matters: a project-scoped variable
// (AO_GITLAB_TOKEN) should win over the global default.
type EnvTokenSource struct {
	EnvVars []string
}

// Token returns the first non-empty value from the configured env vars,
// falling back to GITLAB_TOKEN.
func (s EnvTokenSource) Token(context.Context) (string, error) {
	for _, name := range s.EnvVars {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v, nil
		}
	}
	if v := strings.TrimSpace(os.Getenv("GITLAB_TOKEN")); v != "" {
		return v, nil
	}
	return "", ErrNoToken
}

// FallbackTokenSource tries each source in order, returning the first token.
type FallbackTokenSource []TokenSource

// Token tries each source in order, returning the first successful token.
func (s FallbackTokenSource) Token(ctx context.Context) (string, error) {
	var firstErr error
	for _, src := range s {
		if src == nil {
			continue
		}
		tok, err := src.Token(ctx)
		if err == nil {
			return tok, nil
		}
		if errors.Is(err, ErrNoToken) {
			continue
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", ErrNoToken
}

// InvalidateToken clears cached tokens in all sub-sources that support it.
func (s FallbackTokenSource) InvalidateToken() {
	for _, src := range s {
		if inv, ok := src.(tokenInvalidator); ok {
			inv.InvalidateToken()
		}
	}
}

const defaultGLabTokenCacheTTL = 5 * time.Minute

// defaultGLabFailureCacheTTL bounds how often a *failing* lookup re-spawns
// glab. A host-scoped source whose host glab knows nothing about (or a glab
// too old for `--hostname`) fails on every call, and a failure that is not
// memoized forks a process per token resolution — once per allowlisted host,
// on every API call and every credentials probe. It is deliberately far
// shorter than the success TTL: after `glab auth login --hostname <host>` the
// new credential must become visible quickly.
const defaultGLabFailureCacheTTL = 30 * time.Second

// GLabTokenSource shells out to `glab auth status --show-token` when env vars
// are not configured. It memoizes the result for TokenTTL.
type GLabTokenSource struct {
	// Hostname scopes the lookup to one GitLab instance
	// (`glab auth status --hostname <host>`). Empty asks glab for its own
	// default host. Without it a glab configured for several instances
	// reports whichever host it lists first, so a self-managed host can end up
	// probed with another instance's token.
	Hostname string
	GLab     func(ctx context.Context) (string, error)
	TokenTTL time.Duration
	Clock    func() time.Time

	mu           sync.Mutex
	token        string
	expiresAt    time.Time
	err          error
	errExpiresAt time.Time
}

// Token returns the cached glab token, re-fetching via `glab auth status` when
// the cache expires. Failures are memoized too, for a shorter window, so a
// source glab can never satisfy does not fork a process per call.
func (s *GLabTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.token != "" && now.Before(s.expiresAt) {
		return s.token, nil
	}
	if s.err != nil && now.Before(s.errExpiresAt) {
		return "", s.err
	}
	run := s.GLab
	if run == nil {
		run = func(ctx context.Context) (string, error) { return glabAuthToken(ctx, s.Hostname) }
	}
	out, err := run(ctx)
	if err != nil {
		return "", s.cacheFailure(err, now)
	}
	token := strings.TrimSpace(out)
	if token == "" {
		return "", s.cacheFailure(ErrNoToken, now)
	}
	s.token = token
	s.expiresAt = now.Add(s.ttl())
	s.err, s.errExpiresAt = nil, time.Time{}
	return token, nil
}

// cacheFailure memoizes err until the failure window elapses and returns it
// unchanged, so callers (FallbackTokenSource in particular) still see the
// original ErrNoToken or command error identity.
func (s *GLabTokenSource) cacheFailure(err error, now time.Time) error {
	s.token, s.expiresAt = "", time.Time{}
	s.err = err
	s.errExpiresAt = now.Add(s.failureTTL())
	return err
}

// InvalidateToken clears the cached glab token so the next call re-fetches.
// The memoized failure is cleared with it: an invalidation means the caller
// believes the credential situation changed.
func (s *GLabTokenSource) InvalidateToken() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = ""
	s.expiresAt = time.Time{}
	s.err = nil
	s.errExpiresAt = time.Time{}
}

func (s *GLabTokenSource) now() time.Time {
	if s.Clock != nil {
		return s.Clock()
	}
	return time.Now()
}

func (s *GLabTokenSource) ttl() time.Duration {
	if s.TokenTTL > 0 {
		return s.TokenTTL
	}
	return defaultGLabTokenCacheTTL
}

// failureTTL is the negative-cache window: the success TTL when it is shorter
// (tests pin it), otherwise defaultGLabFailureCacheTTL.
func (s *GLabTokenSource) failureTTL() time.Duration {
	if ttl := s.ttl(); ttl < defaultGLabFailureCacheTTL {
		return ttl
	}
	return defaultGLabFailureCacheTTL
}

// glabAuthToken runs `glab auth status --show-token` and parses the token from
// the output. Unlike `gh auth token` (which prints just the token), glab does not
// have a token-only subcommand — `glab auth status --show-token` prints a
// multi-line status block that includes a line like:
//
//	✓ Token found: glpat-xxxxxxxxxxxxxxxx
//
// hostname, when non-empty, scopes the query to one instance via
// `--hostname`; a glab authenticated against several instances otherwise
// reports them all and the first token line wins, which is not necessarily the
// host being asked about.
//
// If glab is not installed, not authenticated, or exits non-zero for any other
// reason, ErrNoToken is returned so the GitLab provider is silently disabled
// rather than erroring on every poll.
func glabAuthToken(ctx context.Context, hostname string) (string, error) {
	args := []string{"auth", "status", "--show-token"}
	if h := strings.TrimSpace(hostname); h != "" {
		args = append(args, "--hostname", h)
	}
	// glab writes auth status output to stderr, not stdout — use CombinedOutput
	// to capture both streams so the token is not lost.
	out, err := aoprocess.CommandContext(ctx, "glab", args...).CombinedOutput()
	if err != nil {
		return "", ErrNoToken
	}
	token := parseGLabTokenLine(string(out))
	if token == "" {
		return "", ErrNoToken
	}
	return token, nil
}

// parseGLabTokenLine extracts the token value from `glab auth status --show-token`
// output. The token appears on a line containing "Token" followed by a colon
// and the token value (e.g. "✓ Token found: glpat-xxx"). The function scans
// all lines so it is robust against reordering of fields or checkmark prefixes
// in future glab versions.
func parseGLabTokenLine(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		// Match any line containing "Token" — handles both "Token: xxx"
		// and "✓ Token found: xxx" formats across glab versions.
		tokenIdx := strings.Index(line, "Token")
		if tokenIdx < 0 {
			continue
		}
		// Find the colon after "Token" and take everything after it.
		colonIdx := strings.Index(line[tokenIdx:], ":")
		if colonIdx < 0 {
			continue
		}
		val := strings.TrimSpace(line[tokenIdx+colonIdx+1:])
		if val != "" {
			return val
		}
	}
	return ""
}

// HostTokenSource is the token chain for one GitLab host: the shared env vars
// first, then glab scoped to that host, then glab's own default host. The last
// step keeps a single-instance glab setup working when its configured hostname
// does not literally match the remote (and when the installed glab predates
// `--hostname`), which is how this chain behaved before it became host-aware.
func HostTokenSource(host string) TokenSource {
	sources := FallbackTokenSource{
		&EnvTokenSource{EnvVars: []string{"AO_GITLAB_TOKEN"}},
	}
	if h := NormalizeHost(host); h != "" {
		sources = append(sources, &GLabTokenSource{Hostname: h})
	}
	return append(sources, &GLabTokenSource{})
}

// DotComTokenSource is the token chain for gitlab.com: the shared env vars
// first, then glab scoped to gitlab.com.
//
// allowUnscopedGLab appends glab's own default host as a last resort. It is
// safe only when no self-managed instance is configured: an unscoped
// `glab auth status --show-token` on a glab authenticated against several
// instances answers with whichever host it lists first, and sending that
// token to gitlab.com would disclose a self-managed credential to a third
// party. With gitlab.com as the only reachable instance the unscoped token
// can only be the one AO would send there anyway, and the fallback is what
// keeps a glab too old for `--hostname` working.
func DotComTokenSource(allowUnscopedGLab bool) TokenSource {
	sources := FallbackTokenSource{
		&EnvTokenSource{EnvVars: []string{"AO_GITLAB_TOKEN"}},
		&GLabTokenSource{Hostname: DotComHost},
	}
	if allowUnscopedGLab {
		sources = append(sources, &GLabTokenSource{})
	}
	return sources
}
