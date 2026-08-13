package domain

import (
	"encoding/json"
	"time"
)

type ProviderConnection struct {
	ID              string
	OrgID           string
	Provider        string
	Label           string
	Config          json.RawMessage
	ValidationState string
	ValidatedAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// UserProviderConnection is a coding-agent credential a user connects once
// and can use in every organization they belong to — the personal
// counterpart to ProviderConnection's org-shared one. WorkerAgentCredential
// falls back to it only when the session's own org has no connection for
// that harness; it never overrides an org-level one that exists.
type UserProviderConnection struct {
	ID              string
	UserID          string
	Provider        string
	Label           string
	Config          json.RawMessage
	ValidationState string
	ValidatedAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}
