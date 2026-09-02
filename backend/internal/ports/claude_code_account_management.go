package ports

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

var (
	ErrClaudeCodeAccountSwitchInProgress          = errors.New("Claude Code account switch already in progress")
	ErrClaudeCodeAccountAlreadyActive             = errors.New("Claude Code account is already active")
	ErrClaudeCodeAccountNotFound                  = errors.New("Claude Code account not found")
	ErrClaudeCodeActiveAccountUnavailable         = errors.New("active Claude Code account is unavailable")
	ErrClaudeCodeAccountSwitchNotFound            = errors.New("Claude Code account switch not found")
	ErrClaudeCodeAccountRevisionConflict          = errors.New("Claude Code account revision conflict")
	ErrClaudeCodeAccountSwitchIdempotencyConflict = errors.New("Claude Code account switch idempotency conflict")
	ErrClaudeCodeAccountLoginInProgress           = errors.New("Claude Code account login in progress")
	ErrClaudeCodeGlobalAccountChanged             = errors.New("global Claude Code account changed")
	ErrClaudeCodeAccountManagementUnsupported     = errors.New("Claude Code account management unsupported")
	ErrClaudeCodeKeychainUnavailable              = errors.New("Claude Code Keychain unavailable")
)

type ClaudeCodeAccountStateStore interface {
	GetClaudeCodeActiveAccount(context.Context) (domain.ClaudeCodeActiveAccount, bool, error)
	SetClaudeCodeActiveAccount(context.Context, string, int64, time.Time) (domain.ClaudeCodeActiveAccount, error)
}

type ClaudeCodeAccountSwitchConfig struct {
	TargetAccountID         string
	ExpectedAccountRevision int64
	IdempotencyKey          string
}

type ClaudeCodeAccountSwitchStore interface {
	CreateClaudeCodeAccountSwitch(context.Context, domain.ClaudeCodeAccountSwitch) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetClaudeCodeAccountSwitch(context.Context, string) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetClaudeCodeAccountSwitchByIdempotency(context.Context, string) (domain.ClaudeCodeAccountSwitch, bool, error)
	GetActiveClaudeCodeAccountSwitch(context.Context) (domain.ClaudeCodeAccountSwitch, bool, error)
	UpdateClaudeCodeAccountSwitch(context.Context, domain.ClaudeCodeAccountSwitch, domain.ClaudeCodeAccountSwitchPhase) (bool, error)
}

type ClaudeCodeOperationLease interface{ Release() }

type ClaudeCodeOperationGate interface {
	AcquireShared(context.Context) (func(), error)
	AcquireExclusive(context.Context) (ClaudeCodeOperationLease, error)
	ExclusivePendingOrHeld() bool
}

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

type ClaudeCodeCredentialRecoveryOutcome string

const (
	ClaudeCodeCredentialRecoveryCompleted ClaudeCodeCredentialRecoveryOutcome = "completed"
	ClaudeCodeCredentialRecoveryFailed    ClaudeCodeCredentialRecoveryOutcome = "failed"
)

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
