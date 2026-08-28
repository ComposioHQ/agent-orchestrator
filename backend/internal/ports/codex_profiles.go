package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// CodexAccountProfile selects the isolated Codex home used by one structured
// account client. Managed profiles always force Codex's file credential store.
type CodexAccountProfile struct {
	Home    string
	Managed bool
}

// CodexAccountObservation is the safe subset of account/read retained by AO.
type CodexAccountObservation struct {
	Authentication domain.AgentAuthenticationState
	Method         domain.CodexAuthMethod
	Email          *string
}

// CodexLoginStart contains the ephemeral browser-login handles returned by
// Codex. Callers must never persist or log these values.
type CodexLoginStart struct {
	AuthURL string
	LoginID string
}

// CodexAccountEventKind identifies a display-safe app-server account notification.
type CodexAccountEventKind string

const (
	// CodexAccountEventLoginCompleted is emitted for a matching browser login.
	CodexAccountEventLoginCompleted CodexAccountEventKind = "login_completed"
	// CodexAccountEventUpdated is emitted when the active Codex account changes.
	CodexAccountEventUpdated CodexAccountEventKind = "account_updated"
)

// CodexAccountEvent is a normalized account notification. Error details are
// intentionally reduced to a boolean so provider output cannot leak to logs or
// API responses.
type CodexAccountEvent struct {
	Kind    CodexAccountEventKind
	LoginID string
	Success bool
	Failed  bool
}

// CodexAccountClient owns one app-server process for one profile.
type CodexAccountClient interface {
	Read(ctx context.Context, refreshToken bool) (CodexAccountObservation, error)
	StartBrowserLogin(ctx context.Context) (CodexLoginStart, error)
	CancelLogin(ctx context.Context, loginID string) error
	Events() <-chan CodexAccountEvent
	Close() error
}

// CodexAccountClientFactory opens structured account clients and detects the
// installed protocol surface without exposing transport details to services.
type CodexAccountClientFactory interface {
	Open(ctx context.Context, profile CodexAccountProfile) (CodexAccountClient, error)
	Capabilities(ctx context.Context) domain.CodexProfileCapabilities
}

// CodexProfileLaunchResolver is the daemon-owned boundary that turns a profile
// identity or an existing immutable binding into an invocation-scoped launch
// context. Session Manager owns selection and persistence; the agent service
// owns catalog and readiness validation.
type CodexProfileLaunchResolver interface {
	ResolveCodexProfileForLaunch(ctx context.Context, profileID string) (domain.CodexLaunchContext, error)
	ResolveCodexLegacyBinding(ctx context.Context, sessionID domain.SessionID, candidateHome string, createdAt time.Time) (domain.CodexSessionBinding, error)
	ValidateCodexSessionBinding(ctx context.Context, binding domain.CodexSessionBinding) (domain.CodexLaunchContext, error)
	CodexSessionProfileSummary(binding domain.CodexSessionBinding) domain.CodexSessionProfileSummary
	InvalidateCodexProfileAuthentication(profileID string)
}
