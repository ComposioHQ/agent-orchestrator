package ports

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectProvisioner materializes a project and commits its durable placement.
// Provision is idempotent for a non-empty IdempotencyKey: retrying the same
// semantic request returns the same completed provision, while reusing the key
// for a different request returns ErrProjectProvisionIdempotencyConflict.
//
// A returned error never represents a partially visible project/placement pair.
// ErrProjectProvisionUnavailable means completion is not yet known and callers
// may retry the identical request with the same key. Reconciliation,
// compensation, checkpoints, and provider retries are adapter-private.
//
// Remote implementations obtain one-shot SCM credentials from the SCM issuer
// at execution time and deliver their mutable bytes through the compute
// adapter's owner-only secret-file channel. Credentials are never part of this
// request/result contract: they must not be cached, persisted, placed in
// argv/environment/Git configuration, or returned to callers, and both the
// issuer credential and delivered file buffer must be zeroed after use.
type ProjectProvisioner interface {
	Provision(ctx context.Context, request ProjectProvisionRequest) (ProjectProvision, error)
}

var (
	// ErrProjectProvisionIdempotencyConflict reports reuse of an idempotency key
	// with a semantically different request.
	ErrProjectProvisionIdempotencyConflict = errors.New("project provision: idempotency key reused with a different request")
	// ErrProjectProvisionUnavailable reports that a provision did not produce a
	// final result. Retrying the identical request and key is always safe.
	ErrProjectProvisionUnavailable = errors.New("project provision: final result unavailable")
)

// ProjectProvisionRequest describes one existing project creation operation.
// Exactly one operation payload must be non-nil. DefaultBranch is authoritative
// for remote materialization and must be carried through without inspecting a
// control-plane filesystem checkout.
type ProjectProvisionRequest struct {
	IdempotencyKey string
	DefaultBranch  string
	Add            *ProjectAddRequest
	Clone          *ProjectCloneRequest
	Initialize     *ProjectInitializeRequest
}

// ProjectAddRequest describes registration of a repository already visible to
// the provisioner's execution environment.
type ProjectAddRequest struct {
	Path        string
	ProjectID   *string
	Name        *string
	Config      *domain.ProjectConfig
	AsWorkspace bool
}

// ProjectCloneRequest describes cloning and registering a repository. A local
// provisioner uses DestinationParent as a host path; a remote provisioner uses
// its placement root. The remote adapter derives tenant identity from context
// and privately issues a fresh read-only bootstrap credential for RemoteURL;
// no credential material crosses this public boundary.
type ProjectCloneRequest struct {
	RemoteURL         string
	DestinationParent string
	ProjectID         *string
	Name              *string
	Config            *domain.ProjectConfig
}

// ProjectInitializeRequest describes a repository initialization target.
type ProjectInitializeRequest struct {
	Path string
}

// ProjectProvision is the final provider-neutral result. Project is the shared
// durable project model rather than a cloud-only DTO. DefaultBranch repeats the
// authoritative request value so downstream workspace creation never needs to
// probe the control-plane filesystem or Git metadata.
type ProjectProvision struct {
	Project         domain.ProjectRecord
	WorkspaceRepos  []domain.WorkspaceRepoRecord
	Placement       ProjectPlacement
	DefaultBranch   string
	InitializedPath string
}

// ProjectPlacement identifies where the project was materialized. ID is opaque
// outside the provisioner; local implementations may leave it empty and return
// only Path.
type ProjectPlacement struct {
	ID   string
	Path string
}
