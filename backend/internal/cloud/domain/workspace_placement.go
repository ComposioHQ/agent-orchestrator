package domain

import (
	"encoding/json"
	"time"
)

// WorkspacePlacementIntent is the durable operation the placement worker must
// converge. Keeping intent in the record makes accepting a request independent
// from the compute provider and lets a worker resume after a process restart.
type WorkspacePlacementIntent string

const (
	WorkspacePlacementProvision WorkspacePlacementIntent = "provision"
	WorkspacePlacementResume    WorkspacePlacementIntent = "resume"
	WorkspacePlacementDelete    WorkspacePlacementIntent = "delete"
)

// WorkspacePlacementState is the provider-neutral state exposed by the Cloud
// placement API. Provisioning is represented as pending at that boundary.
type WorkspacePlacementState string

const (
	WorkspacePlacementPending WorkspacePlacementState = "pending"
	WorkspacePlacementFailed  WorkspacePlacementState = "failed"
	WorkspacePlacementReady   WorkspacePlacementState = "ready"
)

// CreateWorkspacePlacement describes the immutable request accepted for a
// workspace. Config is opaque provider-neutral JSON owned by the placement
// saga; credentials must never be placed in it.
type CreateWorkspacePlacement struct {
	DisplayName    string
	RepositoryURL  string
	DefaultBranch  string
	Config         json.RawMessage
	IdempotencyKey string
}

// WorkspacePlacement is the durable placement operation and its current
// externally visible result.
type WorkspacePlacement struct {
	ID             string
	OrgID          string
	OwnerUserID    string
	DisplayName    string
	RepositoryURL  string
	DefaultBranch  string
	Config         json.RawMessage
	Intent         WorkspacePlacementIntent
	State          WorkspacePlacementState
	ProjectID      string
	Message        string
	IdempotencyKey string
	// MutationIdempotencyKey and MutationIntent retain the most recently
	// accepted resume/delete request so a completed mutation can still replay.
	MutationIdempotencyKey string
	MutationIntent         WorkspacePlacementIntent
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// WorkspacePlacementPage is one stable, newest-first page.
type WorkspacePlacementPage struct {
	Workspaces []WorkspacePlacement
	HasMore    bool
	NextCursor string
}
