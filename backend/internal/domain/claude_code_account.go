package domain

import "time"

type ClaudeCodeAccountStatus string

const (
	ClaudeCodeAccountStatusValid     ClaudeCodeAccountStatus = "valid"
	ClaudeCodeAccountStatusSignedOut ClaudeCodeAccountStatus = "signed_out"
	ClaudeCodeAccountStatusBroken    ClaudeCodeAccountStatus = "broken"
)

type ClaudeCodeCapabilityState string

const (
	ClaudeCodeCapabilitySupported   ClaudeCodeCapabilityState = "supported"
	ClaudeCodeCapabilityUnsupported ClaudeCodeCapabilityState = "unsupported"
	ClaudeCodeCapabilityUnknown     ClaudeCodeCapabilityState = "unknown"
)

type ClaudeCodeCapabilityObservation struct {
	State      ClaudeCodeCapabilityState `json:"state" enum:"supported,unsupported,unknown"`
	ReasonCode string                    `json:"reasonCode"`
	Reason     string                    `json:"reason"`
}

type ClaudeCodeAccountCapabilities struct {
	AccountRead       ClaudeCodeCapabilityObservation `json:"accountRead"`
	NativeLogin       ClaudeCodeCapabilityObservation `json:"nativeLogin"`
	AccountManagement ClaudeCodeCapabilityObservation `json:"accountManagement"`
	GlobalSwitch      ClaudeCodeCapabilityObservation `json:"globalSwitch"`
	HotReload         ClaudeCodeCapabilityObservation `json:"hotReload"`
	SessionExitResume ClaudeCodeCapabilityObservation `json:"sessionExitResume"`
}

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
	CreatedAt      time.Time                      `json:"createdAt"`
	UpdatedAt      time.Time                      `json:"updatedAt"`
}

type ClaudeCodeActiveAccount struct {
	AccountID   string    `json:"accountId"`
	Revision    int64     `json:"revision"`
	ActivatedAt time.Time `json:"activatedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type ClaudeCodeUnmanagedGlobalAccount struct {
	Label        string  `json:"label"`
	AccountEmail *string `json:"accountEmail,omitempty"`
	ReasonCode   string  `json:"reasonCode"`
	Reason       string  `json:"reason"`
}

type ClaudeCodeAccountLoginStatus string

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

type ClaudeCodeAccountLoginOperation struct {
	OperationID string                       `json:"operationId"`
	AccountID   string                       `json:"accountId,omitempty"`
	Status      ClaudeCodeAccountLoginStatus `json:"status" enum:"pending,verifying,unauthorized,unverified,completed,cancelled,failed,expired"`
	ReasonCode  string                       `json:"reasonCode"`
	Reason      string                       `json:"reason"`
	Account     *ClaudeCodeAccountSnapshot   `json:"account,omitempty"`
	ExpiresAt   time.Time                    `json:"expiresAt"`
}

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
