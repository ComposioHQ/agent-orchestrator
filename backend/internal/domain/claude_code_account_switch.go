package domain

import "time"

// ClaudeCodeAccountSwitchPolicy identifies how a device-global account is activated.
type ClaudeCodeAccountSwitchPolicy string

// ClaudeCodeSwitchPolicyHotReload keeps running Claude processes alive during activation.
const ClaudeCodeSwitchPolicyHotReload ClaudeCodeAccountSwitchPolicy = "hot_reload"

// ClaudeCodeAccountSwitchPhase is a durable coordinator checkpoint.
type ClaudeCodeAccountSwitchPhase string

// Durable Claude Code account-switch phases.
const (
	ClaudeCodeAccountSwitchRequested           ClaudeCodeAccountSwitchPhase = "requested"
	ClaudeCodeAccountSwitchVerifyingTarget     ClaudeCodeAccountSwitchPhase = "verifying_target"
	ClaudeCodeAccountSwitchCheckpointingSource ClaudeCodeAccountSwitchPhase = "checkpointing_source"
	ClaudeCodeAccountSwitchActivatingTarget    ClaudeCodeAccountSwitchPhase = "activating_target"
	ClaudeCodeAccountSwitchUpdatingIdentity    ClaudeCodeAccountSwitchPhase = "updating_identity"
	ClaudeCodeAccountSwitchVerifyingGlobal     ClaudeCodeAccountSwitchPhase = "verifying_global"
	ClaudeCodeAccountSwitchRollbackRequired    ClaudeCodeAccountSwitchPhase = "rollback_required"
	ClaudeCodeAccountSwitchRecoveryRequired    ClaudeCodeAccountSwitchPhase = "recovery_required"
	ClaudeCodeAccountSwitchCompleted           ClaudeCodeAccountSwitchPhase = "completed"
	ClaudeCodeAccountSwitchFailed              ClaudeCodeAccountSwitchPhase = "failed"
)

// Terminal reports whether the switch can no longer advance.
func (p ClaudeCodeAccountSwitchPhase) Terminal() bool {
	return p == ClaudeCodeAccountSwitchCompleted || p == ClaudeCodeAccountSwitchFailed
}

// ClaudeCodeAccountSwitch records one durable, idempotent hot-switch attempt.
type ClaudeCodeAccountSwitch struct {
	ID                        string                        `json:"id"`
	SourceAccountID           string                        `json:"sourceAccountId"`
	TargetAccountID           string                        `json:"targetAccountId"`
	Policy                    ClaudeCodeAccountSwitchPolicy `json:"policy" enum:"hot_reload"`
	Phase                     ClaudeCodeAccountSwitchPhase  `json:"phase"`
	FailureCode               string                        `json:"failureCode,omitempty"`
	CanRecover                bool                          `json:"canRecover"`
	CredentialsCommittedAt    *time.Time                    `json:"credentialsCommittedAt,omitempty"`
	PropagationUncertainUntil *time.Time                    `json:"propagationUncertainUntil,omitempty"`
	CreatedAt                 time.Time                     `json:"createdAt"`
	UpdatedAt                 time.Time                     `json:"updatedAt"`
	CompletedAt               *time.Time                    `json:"completedAt,omitempty"`
	IdempotencyKey            string                        `json:"-"`
	RequestFingerprint        string                        `json:"-"`
	ExpectedAccountRevision   int64                         `json:"-"`
}
