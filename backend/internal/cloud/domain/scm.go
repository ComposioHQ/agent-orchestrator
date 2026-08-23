package domain

import "time"

const SCMProviderGitHub = "github"

const (
	InstallationStatusActive    = "active"
	InstallationStatusSuspended = "suspended"
	InstallationStatusRemoved   = "removed"
)

type SCMInstallation struct {
	ID                     string
	OrgID                  string
	Provider               string
	ExternalInstallationID int64
	AccountLogin           string
	AccountType            string
	AppSlug                string
	RepositorySelection    string
	Status                 string
	LinkedByUserID         string
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

const (
	TokenPurposeClone = "clone"
	TokenPurposePush  = "push"
)

type SCMRepository struct {
	ID                   string
	InstallationID       string
	OrgID                string
	ExternalRepositoryID int64
	FullName             string
	Private              bool
	Allowed              bool
}

type SCMTokenGrant struct {
	OrgID             string
	InstallationID    string
	RepositoryID      string
	SandboxID         string
	Purpose           string
	RequestedByUserID string
	ExpiresAt         time.Time
}

const (
	SCMWebhookClassificationObservation = "observation"
	SCMWebhookClassificationIgnored     = "ignored"
	SCMWebhookClassificationMalformed   = "malformed_json"
)

const (
	SCMWebhookStateProcessing = "processing"
	SCMWebhookStateRetry      = "retry"
	SCMWebhookStateComplete   = "complete"
	SCMWebhookStateDeadLetter = "dead_letter"
)

const (
	SCMWebhookOutcomeComplete = "complete"
	SCMWebhookOutcomeRetry    = "retry"
)

// SCMWebhookReceipt is the complete durable input for a verified delivery.
// A store must persist it and acquire any initial lease atomically.
type SCMWebhookReceipt struct {
	Provider       string
	DeliveryID     string
	Event          string
	Body           []byte
	Classification string
	TerminalError  string
}

// SCMWebhookClaim is one exclusive processing lease. LeaseID must accompany
// completion so an expired worker cannot finish a subsequently recovered
// attempt.
type SCMWebhookClaim struct {
	Provider       string
	DeliveryID     string
	Event          string
	Body           []byte
	Classification string
	State          string
	LeaseID        string
	Attempts       int
	FirstReceipt   bool
	Claimed        bool
	ReceivedAt     time.Time
	NextAttemptAt  time.Time
	LeaseExpiresAt time.Time
}
