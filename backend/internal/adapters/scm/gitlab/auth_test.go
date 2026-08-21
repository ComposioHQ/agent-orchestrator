package gitlab

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestParseGLabTokenLine(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   string
	}{
		{
			name: "real glab output with checkmark",
			output: "Hostname: gitlab.com\n" +
				"✓ Token found: glpat-xxxxxxxxxxxxxxxx\n" +
				"Api Protocol: https\n",
			want: "glpat-xxxxxxxxxxxxxxxx",
		},
		{
			name:   "plain Token: prefix without checkmark",
			output: "Token: glpat-yyyy\n",
			want:   "glpat-yyyy",
		},
		{
			name:   "token line with trailing whitespace",
			output: "✓ Token found: glpat-yyy  \n",
			want:   "glpat-yyy",
		},
		{
			name:   "token line with extra spaces after colon",
			output: "Token:    glpat-spaced\n",
			want:   "glpat-spaced",
		},
		{
			name:   "no token line",
			output: "Hostname: gitlab.com\nApi Protocol: https\n",
			want:   "",
		},
		{
			name:   "empty token value",
			output: "✓ Token found: \n",
			want:   "",
		},
		{
			name:   "empty output",
			output: "",
			want:   "",
		},
		{
			name: "token not on first line",
			output: "Api Protocol: https\n" +
				"Hostname: gitlab.com\n" +
				"✓ Token found: glpat-zzz\n",
			want: "glpat-zzz",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseGLabTokenLine(tt.output)
			if got != tt.want {
				t.Fatalf("parseGLabTokenLine() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestGLabTokenSourceUsesInjectedHook(t *testing.T) {
	calls := 0
	src := &GLabTokenSource{
		GLab: func(ctx context.Context) (string, error) {
			calls++
			return "glpat-from-hook\n", nil
		},
		TokenTTL: time.Hour,
	}
	tok, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "glpat-from-hook" {
		t.Fatalf("token = %q, want glpat-from-hook", tok)
	}
	// Second call must use the cache (no new shell-out).
	tok2, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token (cached): %v", err)
	}
	if tok2 != "glpat-from-hook" {
		t.Fatalf("cached token = %q", tok2)
	}
	if calls != 1 {
		t.Fatalf("hook called %d times, want 1 (cached)", calls)
	}
}

func TestGLabTokenSourceRejectsEmptyOutput(t *testing.T) {
	src := &GLabTokenSource{
		GLab: func(ctx context.Context) (string, error) {
			return "", nil
		},
	}
	_, err := src.Token(context.Background())
	if !errors.Is(err, ErrNoToken) {
		t.Fatalf("err = %v, want ErrNoToken", err)
	}
}

func TestGLabTokenSourcePropagatesNonNoTokenError(t *testing.T) {
	boom := errors.New("boom")
	src := &GLabTokenSource{
		GLab: func(ctx context.Context) (string, error) {
			return "", boom
		},
	}
	_, err := src.Token(context.Background())
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}

func TestGLabTokenSourceInvalidateClearsCache(t *testing.T) {
	calls := 0
	src := &GLabTokenSource{
		GLab: func(ctx context.Context) (string, error) {
			calls++
			return "glpat-aaa\n", nil
		},
		TokenTTL: time.Hour,
	}
	if _, err := src.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	src.InvalidateToken()
	if _, err := src.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("hook called %d times, want 2 (cache invalidated)", calls)
	}
}

// TestGLabTokenSourceParsesHookOutput verifies that the GLab hook returns
// just the parsed token (same as glabAuthToken would), not the raw status block.
func TestGLabTokenSourceParsesHookOutput(t *testing.T) {
	src := &GLabTokenSource{
		GLab: func(ctx context.Context) (string, error) {
			// The real glabAuthToken parses `glab auth status --show-token` output
			// and returns just the token. The injected hook mirrors that contract.
			return "glpat-parsed\n", nil
		},
		TokenTTL: time.Hour,
	}
	tok, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "glpat-parsed" {
		t.Fatalf("token = %q, want glpat-parsed", tok)
	}
}

// TestHostTokenSourceScopesGLabToHost covers the per-host chain: glab must be
// asked about the specific instance before it is asked about its default one,
// so a glab authenticated against several hosts cannot hand back a token that
// belongs to a different instance.
func TestHostTokenSourceScopesGLabToHost(t *testing.T) {
	chain, ok := HostTokenSource(" GitLab.Internal:8443 ").(FallbackTokenSource)
	if !ok {
		t.Fatalf("HostTokenSource returned %T, want FallbackTokenSource", HostTokenSource("gitlab.internal"))
	}
	if len(chain) != 3 {
		t.Fatalf("chain length = %d, want env + scoped glab + default glab", len(chain))
	}
	if _, ok := chain[0].(*EnvTokenSource); !ok {
		t.Fatalf("chain[0] = %T, want *EnvTokenSource", chain[0])
	}
	scoped, ok := chain[1].(*GLabTokenSource)
	if !ok {
		t.Fatalf("chain[1] = %T, want *GLabTokenSource", chain[1])
	}
	if scoped.Hostname != "gitlab.internal:8443" {
		t.Fatalf("scoped hostname = %q, want the normalized host", scoped.Hostname)
	}
	fallback, ok := chain[2].(*GLabTokenSource)
	if !ok {
		t.Fatalf("chain[2] = %T, want *GLabTokenSource", chain[2])
	}
	if fallback.Hostname != "" {
		t.Fatalf("fallback hostname = %q, want glab's own default host", fallback.Hostname)
	}
}

// TestHostTokenSourceWithoutHostSkipsScopedLookup covers the gitlab.com case:
// with no host there is nothing to scope to, so only the default glab lookup
// is used.
func TestHostTokenSourceWithoutHostSkipsScopedLookup(t *testing.T) {
	chain, ok := HostTokenSource("").(FallbackTokenSource)
	if !ok {
		t.Fatalf("HostTokenSource returned %T, want FallbackTokenSource", HostTokenSource(""))
	}
	if len(chain) != 2 {
		t.Fatalf("chain length = %d, want env + default glab", len(chain))
	}
	src, ok := chain[1].(*GLabTokenSource)
	if !ok || src.Hostname != "" {
		t.Fatalf("chain[1] = %#v, want an unscoped *GLabTokenSource", chain[1])
	}
}

// TestGLabTokenSourceMemoizesFailures covers the negative cache: a source glab
// cannot satisfy (an unknown --hostname, or a glab too old for the flag) is
// consulted on every token resolution, once per allowlisted host. Without a
// memo each of those forks a process; the failure must be remembered instead.
func TestGLabTokenSourceMemoizesFailures(t *testing.T) {
	for _, tt := range []struct {
		name string
		out  string
		err  error
	}{
		{name: "command failure", err: errors.New("unknown flag: --hostname")},
		{name: "no token printed", out: ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			now := time.Now()
			src := &GLabTokenSource{
				Hostname: "gitlab.internal",
				GLab: func(context.Context) (string, error) {
					calls++
					return tt.out, tt.err
				},
				Clock: func() time.Time { return now },
			}
			for i := 0; i < 5; i++ {
				if _, err := src.Token(context.Background()); err == nil {
					t.Fatalf("Token call %d succeeded, want a failure", i)
				}
			}
			if calls != 1 {
				t.Fatalf("hook called %d times, want 1 (failure memoized)", calls)
			}

			// The memo is short-lived: after `glab auth login` the credential
			// must become visible without a restart.
			now = now.Add(defaultGLabFailureCacheTTL + time.Second)
			if _, err := src.Token(context.Background()); err == nil {
				t.Fatal("Token after the failure window succeeded, want a failure")
			}
			if calls != 2 {
				t.Fatalf("hook called %d times, want 2 (failure window elapsed)", calls)
			}
		})
	}
}

// TestGLabTokenSourceInvalidateClearsFailure covers InvalidateToken on a
// memoized failure: the caller believes the credential situation changed, so
// the next call must shell out again rather than replay the cached error.
func TestGLabTokenSourceInvalidateClearsFailure(t *testing.T) {
	calls := 0
	src := &GLabTokenSource{
		GLab: func(context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", ErrNoToken
			}
			return "glpat-after-login\n", nil
		},
		TokenTTL: time.Hour,
	}
	if _, err := src.Token(context.Background()); !errors.Is(err, ErrNoToken) {
		t.Fatalf("err = %v, want ErrNoToken", err)
	}
	src.InvalidateToken()
	tok, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token after invalidate: %v", err)
	}
	if tok != "glpat-after-login" {
		t.Fatalf("token = %q, want glpat-after-login", tok)
	}
}

// TestGLabTokenSourceRefetchesAfterFailureWindow covers recovery from a
// transient glab failure: the memo suppresses the shell-out only until the
// failure window elapses, after which the real token is picked up.
func TestGLabTokenSourceRefetchesAfterFailureWindow(t *testing.T) {
	calls := 0
	now := time.Now()
	src := &GLabTokenSource{
		GLab: func(context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", errors.New("keyring locked")
			}
			return "glpat-recovered\n", nil
		},
		TokenTTL: time.Hour,
		Clock:    func() time.Time { return now },
	}
	if _, err := src.Token(context.Background()); err == nil {
		t.Fatal("first Token succeeded, want the command failure")
	}
	now = now.Add(defaultGLabFailureCacheTTL + time.Second)
	tok, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token after the failure window: %v", err)
	}
	if tok != "glpat-recovered" {
		t.Fatalf("token = %q, want glpat-recovered", tok)
	}
}

// TestDotComTokenSourceScopesGLabToDotCom covers the gitlab.com chain when a
// self-managed instance is configured: glab must be asked about gitlab.com
// specifically, and the unscoped lookup must not be a fallback. An unscoped
// `glab auth status --show-token` on a multi-instance setup answers with
// whichever host it lists first, so keeping it would send a self-managed
// token to gitlab.com — a disclosure to a third party.
func TestDotComTokenSourceScopesGLabToDotCom(t *testing.T) {
	chain, ok := DotComTokenSource(false).(FallbackTokenSource)
	if !ok {
		t.Fatalf("DotComTokenSource returned %T, want FallbackTokenSource", DotComTokenSource(false))
	}
	if len(chain) != 2 {
		t.Fatalf("chain length = %d, want env + glab scoped to gitlab.com", len(chain))
	}
	if _, ok := chain[0].(*EnvTokenSource); !ok {
		t.Fatalf("chain[0] = %T, want *EnvTokenSource", chain[0])
	}
	scoped, ok := chain[1].(*GLabTokenSource)
	if !ok {
		t.Fatalf("chain[1] = %T, want *GLabTokenSource", chain[1])
	}
	if scoped.Hostname != DotComHost {
		t.Fatalf("scoped hostname = %q, want %q", scoped.Hostname, DotComHost)
	}
}

// TestDotComTokenSourceKeepsUnscopedGLabFallback covers the plain gitlab.com
// setup: with no self-managed instance configured, an unscoped glab token can
// only be the one AO would send to gitlab.com anyway, so the fallback stays —
// it is what keeps a glab too old for `--hostname` working.
func TestDotComTokenSourceKeepsUnscopedGLabFallback(t *testing.T) {
	chain, ok := DotComTokenSource(true).(FallbackTokenSource)
	if !ok {
		t.Fatalf("DotComTokenSource returned %T, want FallbackTokenSource", DotComTokenSource(true))
	}
	if len(chain) != 3 {
		t.Fatalf("chain length = %d, want env + scoped glab + default glab", len(chain))
	}
	fallback, ok := chain[2].(*GLabTokenSource)
	if !ok {
		t.Fatalf("chain[2] = %T, want *GLabTokenSource", chain[2])
	}
	if fallback.Hostname != "" {
		t.Fatalf("fallback hostname = %q, want glab's own default host", fallback.Hostname)
	}
}
