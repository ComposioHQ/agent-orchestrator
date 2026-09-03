package domain

import "time"

// ClaudeCodeAccountStatus describes whether a saved account can authenticate.
type ClaudeCodeAccountStatus string

// Claude Code account status values.
const (
	ClaudeCodeAccountStatusValid     ClaudeCodeAccountStatus = "valid"
	ClaudeCodeAccountStatusSignedOut ClaudeCodeAccountStatus = "signed_out"
	ClaudeCodeAccountStatusBroken    ClaudeCodeAccountStatus = "broken"
)

// ClaudeCodeCapabilityState describes support for one account-management operation.
type ClaudeCodeCapabilityState string

// Claude Code capability support states.
const (
	ClaudeCodeCapabilitySupported   ClaudeCodeCapabilityState = "supported"
	ClaudeCodeCapabilityUnsupported ClaudeCodeCapabilityState = "unsupported"
	ClaudeCodeCapabilityUnknown     ClaudeCodeCapabilityState = "unknown"
)

// ClaudeCodeCapabilityObservation pairs capability support with a safe explanation.
type ClaudeCodeCapabilityObservation struct {
	State      ClaudeCodeCapabilityState `json:"state" enum:"supported,unsupported,unknown"`
	ReasonCode string                    `json:"reasonCode"`
	Reason     string                    `json:"reason"`
}

// ClaudeCodeAccountCapabilities reports each independently gated account operation.
type ClaudeCodeAccountCapabilities struct {
	AccountRead       ClaudeCodeCapabilityObservation `json:"accountRead"`
	NativeLogin       ClaudeCodeCapabilityObservation `json:"nativeLogin"`
	AccountManagement ClaudeCodeCapabilityObservation `json:"accountManagement"`
	GlobalSwitch      ClaudeCodeCapabilityObservation `json:"globalSwitch"`
	HotReload         ClaudeCodeCapabilityObservation `json:"hotReload"`
	SessionExitResume ClaudeCodeCapabilityObservation `json:"sessionExitResume"`
}

// ClaudeCodeAccountIdentity is the allowlisted non-secret identity projection.
type ClaudeCodeAccountIdentity struct {
	AccountUUID           string  `json:"accountUuid"`
	EmailAddress          string  `json:"emailAddress,omitempty"`
	DisplayName           string  `json:"displayName,omitempty"`
	OrganizationUUID      string  `json:"organizationUuid,omitempty"`
	OrganizationName      string  `json:"organizationName,omitempty"`
	BillingType           string  `json:"billingType,omitempty"`
	SeatTier              string  `json:"seatTier,omitempty"`
	AccountCreatedAt      *string `json:"accountCreatedAt,omitempty"`
	SubscriptionCreatedAt *string `json:"subscriptionCreatedAt,omitempty"`
}

// ClaudeCodeAccountSnapshot is the public state of a saved Claude Code account.
type ClaudeCodeAccountSnapshot struct {
	ID             string                         `json:"id"`
	Label          string                         `json:"label"`
	Status         ClaudeCodeAccountStatus        `json:"status" enum:"valid,signed_out,broken"`
	ReasonCode     string                         `json:"reasonCode"`
	Reason         string                         `json:"reason"`
	Active         bool                           `json:"active"`
	Authentication AgentAuthenticationObservation `json:"authentication"`
	Identity       ClaudeCodeAccountIdentity      `json:"identity"`
	AccountEmail   *string                        `json:"accountEmail,omitempty"`
	PlanUsage      ClaudeCodePlanUsageSnapshot    `json:"planUsage"`
	CreatedAt      time.Time                      `json:"createdAt"`
	UpdatedAt      time.Time                      `json:"updatedAt"`
}

// ClaudeCodeActiveAccount is the revisioned device-global active-account pointer.
type ClaudeCodeActiveAccount struct {
	AccountID   string    `json:"accountId"`
	Revision    int64     `json:"revision"`
	ActivatedAt time.Time `json:"activatedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ClaudeCodeUnmanagedGlobalAccount describes a canonical login AO cannot reconcile safely.
type ClaudeCodeUnmanagedGlobalAccount struct {
	Label        string  `json:"label"`
	AccountEmail *string `json:"accountEmail,omitempty"`
	ReasonCode   string  `json:"reasonCode"`
	Reason       string  `json:"reason"`
}

// ClaudeCodeAccountLoginStatus describes an isolated login operation.
type ClaudeCodeAccountLoginStatus string

// Claude Code isolated-login states.
const (
	ClaudeCodeAccountLoginPending      ClaudeCodeAccountLoginStatus = "pending"
	ClaudeCodeAccountLoginVerifying    ClaudeCodeAccountLoginStatus = "verifying"
	ClaudeCodeAccountLoginUnauthorized ClaudeCodeAccountLoginStatus = "unauthorized"
	ClaudeCodeAccountLoginUnverified   ClaudeCodeAccountLoginStatus = "unverified"
	ClaudeCodeAccountLoginCompleted    ClaudeCodeAccountLoginStatus = "completed"
	ClaudeCodeAccountLoginCancelled    ClaudeCodeAccountLoginStatus = "cancelled"
	ClaudeCodeAccountLoginFailed       ClaudeCodeAccountLoginStatus = "failed"
	ClaudeCodeAccountLoginExpired      ClaudeCodeAccountLoginStatus = "expired"
)

// ClaudeCodeAccountLoginOperation is the safe public state of an isolated login.
type ClaudeCodeAccountLoginOperation struct {
	OperationID string                       `json:"operationId"`
	AccountID   string                       `json:"accountId,omitempty"`
	Status      ClaudeCodeAccountLoginStatus `json:"status" enum:"pending,verifying,unauthorized,unverified,completed,cancelled,failed,expired"`
	ReasonCode  string                       `json:"reasonCode"`
	Reason      string                       `json:"reason"`
	Account     *ClaudeCodeAccountSnapshot   `json:"account,omitempty"`
	ExpiresAt   time.Time                    `json:"expiresAt"`
}

// Claude Code account and capability reason codes.
const (
	ClaudeCodeAccountReasonValid                   = "account_valid"
	ClaudeCodeAccountReasonSignedOut               = "account_signed_out"
	ClaudeCodeAccountReasonBroken                  = "account_broken"
	ClaudeCodeAccountReasonSupported               = "supported"
	ClaudeCodeAccountReasonUnsupportedPlatform     = "unsupported_platform"
	ClaudeCodeAccountReasonUnsupportedVersion      = "unsupported_version"
	ClaudeCodeAccountReasonEnvironmentAuthOverride = "environment_auth_override"
	ClaudeCodeAccountReasonKeychainUnavailable     = "keychain_unavailable"
)
