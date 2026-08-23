package domain

import (
	"errors"
	"time"
)

var (
	// ErrSCMNotFound means a tenant-scoped SCM record is absent or invisible.
	ErrSCMNotFound = errors.New("cloud scm record not found")
	// ErrSCMConflict means an installation is already claimed by another tenant.
	ErrSCMConflict = errors.New("cloud scm record conflicts with existing ownership")
)

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

// SCMInstallationLink is the tenant identity recovered from one install state.
type SCMInstallationLink struct {
	OrgID                  string
	UserID                 string
	ExternalInstallationID int64
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
	CreatedAt            time.Time
	UpdatedAt            time.Time
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

// SCMObservationSignal is a normalized provider refresh hint keyed by delivery.
type SCMObservationSignal struct {
	ExternalInstallationID int64
	Repository             string
	PullRequestNumber      int
	PullRequestURL         string
	HeadSHA                string
	Event                  string
	Action                 string
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
