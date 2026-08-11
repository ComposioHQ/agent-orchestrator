package domain

import (
	"encoding/json"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

type Principal struct {
	UserID        string
	Provider      string
	ExternalID    string
	Email         string
	DisplayName   string
	ExternalOrgID string
	OrgName       string
	OrgRole       string
}

type Membership struct {
	OrgID       string
	OrgSlug     string
	DisplayName string
	Role        string
}

type LocalRegistration struct {
	Email        string
	DisplayName  string
	PasswordHash string
	OrgSlug      string
	OrgName      string
}

type Project struct {
	ID                 string
	OrgID              string
	DisplayName        string
	RepositoryURL      string
	DefaultBranch      string
	GitHubRepositoryID *int64
	Config             json.RawMessage
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type CreateProject struct {
	DisplayName   string
	RepositoryURL string
	DefaultBranch string
	Config        json.RawMessage
}

type Session struct {
	ID               string
	OrgID            string
	ProjectID        string
	Kind             string
	Harness          string
	DisplayName      string
	Branch           string
	Mode             string
	DeniedCommands   []string
	ActivityState    contract.ActivityState
	IsTerminated     bool
	RuntimeConnected bool
	RuntimeState     string
	RuntimeError     string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

func (s Session) Status(now time.Time) contract.SessionStatus {
	return contract.DeriveStatus(contract.SessionFacts{
		Activity:       s.ActivityState,
		LastActivityAt: s.UpdatedAt,
		HasSignal:      s.RuntimeConnected,
		SignalExpected: s.RuntimeState != "",
		IsTerminated:   s.IsTerminated,
	}, nil, now, 2*time.Minute)
}

type CreateSession struct {
	ProjectID           string
	Kind                string
	Harness             string
	DisplayName         string
	Prompt              string
	Mode                string
	DeniedCommands      []string
	Provider            string
	SandboxConnectionID string
}

type ClientEvent struct {
	SessionID string
	Sequence  int64
	Type      string
	Payload   json.RawMessage
	CreatedAt time.Time
}

type Cursor struct {
	Time time.Time
	ID   string
}
