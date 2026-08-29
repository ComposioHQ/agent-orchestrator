package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// CodexProfileSwitchOptionProvider is the agent-service boundary consumed by
// Session Manager. Cached reads are side-effect free; verification performs
// the strict exact-profile checks required before source shutdown.
type CodexProfileSwitchOptionProvider interface {
	CachedCodexProfileSwitchOptions(sourceBinding domain.CodexSessionBinding) domain.CodexProfileSwitchOptions
	EnsureCodexProfileSwitchOptions(ctx context.Context, sourceBinding domain.CodexSessionBinding) (domain.CodexProfileSwitchOptions, error)
	VerifyCodexProfileSwitchTarget(ctx context.Context, profileID string, acknowledgeUnknownCapacity bool) (domain.CodexProfileSwitchVerification, error)
}

// CodexProfileSwitchStore owns durable assisted-continuation transitions.
// Update is compare-and-swap on the observed phase and generation fences.
type CodexProfileSwitchStore interface {
	CreateCodexProfileSwitch(ctx context.Context, rec domain.CodexProfileSwitch) (domain.CodexProfileSwitch, bool, error)
	GetCodexProfileSwitch(ctx context.Context, id domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, bool, error)
	GetCodexProfileSwitchByIdempotencyKey(ctx context.Context, sourceSessionID domain.SessionID, idempotencyKey string) (domain.CodexProfileSwitch, bool, error)
	GetActiveCodexProfileSwitch(ctx context.Context, sourceSessionID domain.SessionID) (domain.CodexProfileSwitch, bool, error)
	GetCodexProfileSwitchForSession(ctx context.Context, sessionID domain.SessionID) (domain.CodexProfileSwitch, bool, error)
	ListCodexProfileSwitches(ctx context.Context, sourceSessionID domain.SessionID) ([]domain.CodexProfileSwitch, error)
	ListActiveCodexProfileSwitches(ctx context.Context) ([]domain.CodexProfileSwitch, error)
	UpdateCodexProfileSwitch(ctx context.Context, rec domain.CodexProfileSwitch, expectedPhase domain.CodexProfileSwitchPhase, expectedSourceGenerationID, expectedTargetGenerationID domain.AgentGenerationID) (bool, error)
	AcknowledgeCodexProfileSwitchTarget(ctx context.Context, id domain.CodexProfileSwitchID, targetSessionID domain.SessionID, targetGenerationID domain.AgentGenerationID, acknowledgedAt time.Time) (bool, error)

	// CreateCodexProfileSwitchTarget allocates the related session, immutable
	// binding, switch relation, and worktree ownership move atomically.
	CreateCodexProfileSwitchTarget(ctx context.Context, sw domain.CodexProfileSwitch, seed domain.SessionRecord, binding domain.CodexSessionBinding, now time.Time) (domain.SessionRecord, domain.CodexProfileSwitch, error)
	// CompleteCodexProfileSwitch transfers final workspace ownership, archives
	// the predecessor, and completes the switch in one transaction.
	CompleteCodexProfileSwitch(ctx context.Context, sw domain.CodexProfileSwitch, acknowledgedAt time.Time) (domain.CodexProfileSwitch, bool, error)
	// RestoreCodexProfileSwitchSource moves worktree ownership back only for the
	// existing target and leaves a terminal failed operation.
	RestoreCodexProfileSwitchSource(ctx context.Context, sw domain.CodexProfileSwitch, restoredAt time.Time) (domain.CodexProfileSwitch, bool, error)
}
