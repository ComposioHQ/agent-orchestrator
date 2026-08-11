package domain

import (
	"encoding/json"
	"time"
)

type GitHubInstallation struct {
	ID                   string
	OrgID                string
	GitHubInstallationID int64
	GitHubAccountID      int64
	AccountLogin         string
	AccountType          string
	Status               string
	RepositorySelection  string
	Permissions          json.RawMessage
	Events               []string
	SyncStatus           string
	SyncGeneration       int64
	LastSyncedAt         *time.Time
	LastError            string
	InstalledByUserID    string
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type GitHubInstallAttempt struct {
	ID                          string
	OrgID                       string
	InitiatingUserID            string
	Phase                       string
	PendingGitHubInstallationID int64
	OAuthVerifierCiphertext     []byte
	OAuthVerifierNonce          []byte
	ExpiresAt                   time.Time
}

type GitHubRepository struct {
	GrantID            string
	GitHubRepositoryID int64
	GitHubOwnerID      int64
	Name               string
	FullName           string
	HTMLURL            string
	CloneURL           string
	SSHURL             string
	DefaultBranch      string
	Visibility         string
	IsPrivate          bool
	IsArchived         bool
	IsDisabled         bool
	GitHubUpdatedAt    *time.Time
	GrantedAt          time.Time
	RevokedAt          *time.Time
}

type CreateGitHubProject struct {
	GitHubRepositoryID int64
	DisplayName        string
	Config             json.RawMessage
}

type GitHubWebhookDelivery struct {
	DeliveryID           string
	Event                string
	Action               string
	GitHubInstallationID int64
	GitHubRepositoryID   int64
	Payload              []byte
	AttemptCount         int
}
