package ports

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Claude Code account-management errors used across service boundaries.
var (
	ErrClaudeCodeAccountSwitchInProgress          = errors.New("account switch already in progress for Claude Code")
	ErrClaudeCodeAccountAlreadyActive             = errors.New("account is already active for Claude Code")
	ErrClaudeCodeAccountDeleteRequiresLogout      = errors.New("account must be signed out before deletion for Claude Code")
	ErrClaudeCodeAccountNotFound                  = errors.New("account not found for Claude Code")
	ErrClaudeCodeActiveAccountUnavailable         = errors.New("active Claude Code account is unavailable")
	ErrClaudeCodeAccountSwitchNotFound            = errors.New("account switch not found for Claude Code")
	ErrClaudeCodeAccountRevisionConflict          = errors.New("account revision conflict for Claude Code")
	ErrClaudeCodeAccountSwitchIdempotencyConflict = errors.New("account switch idempotency conflict for Claude Code")
	ErrClaudeCodeAccountLoginInProgress           = errors.New("account login in progress for Claude Code")
	ErrClaudeCodeGlobalAccountChanged             = errors.New("global Claude Code account changed")
	ErrClaudeCodeAccountManagementUnsupported     = errors.New("account management unsupported for Claude Code")
	ErrClaudeCodeKeychainUnavailable              = errors.New("keychain unavailable for Claude Code")
	ErrClaudeCodePlanUsageUnavailable             = errors.New("plan usage unavailable for Claude Code")
	ErrClaudeCodePlanUsageRateLimited             = errors.New("plan usage rate limited for Claude Code")
	ErrClaudeCodePlanUsageInvalid                 = errors.New("plan usage response invalid for Claude Code")
)

// ClaudeCodePlanUsageObservation is the provider usage response before service caching.
type ClaudeCodePlanUsageObservation struct {
	Plan       *string
	Promotion  *domain.ClaudeCodePlanPromotion
	Windows    []domain.ClaudeCodePlanUsageWindow
	ObservedAt time.Time
}

// ClaudeCodeUsageReader reads one account's remote subscription limits.
// Implementations keep OAuth material below the service boundary.
type ClaudeCodeUsageReader interface {
	ReadPlanUsage(context.Context, string) (ClaudeCodePlanUsageObservation, error)
}

// ClaudeCodeAccountStateStore persists the revisioned active-account pointer.
type ClaudeCodeAccountStateStore interface {
	GetClaudeCodeActiveAccount(context.Context) (domain.ClaudeCodeActiveAccount, bool, error)
	SetClaudeCodeActiveAccount(context.Context, string, int64, time.Time) (domain.ClaudeCodeActiveAccount, error)
}

// ClaudeCodeAccountSwitchConfig contains client concurrency and idempotency controls.
type ClaudeCodeAccountSwitchConfig struct {
	TargetAccountID         string
	ExpectedAccountRevision int64
	IdempotencyKey          string
}

// ClaudeCodeAccountSwitchStore persists durable account-switch state.
type ClaudeCodeAccountSwitchStore interface {
	CreateClaudeCodeAccountSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetClaudeCodeAccountSwitch(context.Context, string) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetClaudeCodeAccountSwitchByIdempotency(context.Context, string) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetActiveClaudeCodeAccountSwitch(context.Context) (domain.ClaudeCodeAccountSwitch, bool, error)
	UpdateClaudeCodeAccountSwitch(context.Context, domain.ClaudeCodeAccountSwitch, domain.ClaudeCodeAccountSwitchPhase) (bool, error)
}

// ClaudeCodeOperationLease owns an exclusive Claude account-operation fence.
type ClaudeCodeOperationLease interface{ Release() }

// ClaudeCodeOperationGate coordinates shared launches with exclusive credential mutations.
type ClaudeCodeOperationGate interface {
	AcquireShared(context.Context) (func(), error)
	AcquireExclusive(context.Context) (ClaudeCodeOperationLease, error)
	ExclusivePendingOrHeld() bool
}

// ClaudeCodeCredentialSwitch performs one credential transaction under native locks.
type ClaudeCodeCredentialSwitch interface {
	CheckpointSource(context.Context) error
	ActivateTarget(context.Context) error
	UpdateIdentity(context.Context) (time.Time, error)
	ReleaseNativeLocks()
	VerifyGlobal(context.Context) error
	CommitActivePointer(context.Context) (domain.ClaudeCodeActiveAccount, error)
	Rollback(context.Context) error
	Cleanup(context.Context) error
}

// ClaudeCodeCredentialRecoveryOutcome identifies which side recovery verified.
type ClaudeCodeCredentialRecoveryOutcome string

// Claude Code credential-recovery outcomes.
const (
	ClaudeCodeCredentialRecoveryCompleted ClaudeCodeCredentialRecoveryOutcome = "completed"
	ClaudeCodeCredentialRecoveryFailed    ClaudeCodeCredentialRecoveryOutcome = "failed"
)

// ClaudeCodeAccountCredentialManager supplies credential transactions to the coordinator.
type ClaudeCodeAccountCredentialManager interface {
	WaitClaudeCodeAccountBootstrap(context.Context) error
	CurrentClaudeCodeActiveAccount() domain.ClaudeCodeActiveAccount
	ClaudeCodeAccountLoginInProgress() bool
	BeginClaudeCodeAccountMutation(context.Context) error
	EndClaudeCodeAccountMutation()
	StageClaudeCodeAccountForSwitch(context.Context, string, string) error
	BeginClaudeCodeCredentialSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (ClaudeCodeCredentialSwitch, error)
	RecoverClaudeCodeCredentialSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (ClaudeCodeCredentialRecoveryOutcome, *time.Time, error)
	CleanupClaudeCodeSwitchArtifacts(context.Context, string) error
	PublishClaudeCodeAccounts()
}
