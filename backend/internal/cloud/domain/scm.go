package domain

import "time"

// SCM provider keys recognized by the hosted control plane. Only GitHub App
// installations are supported in v1.
const (
	SCMProviderGitHub = "github"
)

// Installation status values. `removed` is retained rather than deleted so an
// audit trail of past credential scope survives an uninstall.
const (
	InstallationStatusActive    = "active"
	InstallationStatusSuspended = "suspended"
	InstallationStatusRemoved   = "removed"
)

// Token grant purposes recorded in the audit ledger.
const (
	TokenPurposeClone   = "clone"
	TokenPurposePush    = "push"
	TokenPurposeObserve = "observe"
)

// SCMInstallation is one provider app installation linked to one AO
// organization. It never carries credential material: the control plane mints
// scoped tokens on demand from the app private key.
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

// SCMRepository is one repository visible to an installation. Allowed is the
// enforcement flag the token broker reads; visibility alone never authorizes a
// clone or a push.
type SCMRepository struct {
	ID                   string
	InstallationID       string
	OrgID                string
	ExternalRepositoryID int64
	FullName             string
	Private              bool
	Allowed              bool
	AllowedByUserID      string
	AllowedAt            time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// SCMInstallationLink is the resolved owner of a pending install redirect.
type SCMInstallationLink struct {
	OrgID  string
	UserID string
}

// SCMTokenGrant is the audit record written whenever a repository-scoped
// installation token is brokered. Token material is deliberately absent.
type SCMTokenGrant struct {
	OrgID             string
	InstallationID    string
	RepositoryID      string
	WorkspaceID       string
	Purpose           string
	RequestedByUserID string
	ExpiresAt         time.Time
}
