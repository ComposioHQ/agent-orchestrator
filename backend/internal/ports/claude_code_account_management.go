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
