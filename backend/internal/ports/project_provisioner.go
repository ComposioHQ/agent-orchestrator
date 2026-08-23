package ports

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectProvisioner materializes and durably registers a project.
// Provision is idempotent for a non-empty IdempotencyKey: retrying the same
// semantic request returns the same completed provision, while reusing the key
// for a different request returns a permanent ProjectProvisionError that wraps
// the service's existing conflict error.
//
// A returned error never represents a partially visible project. A retryable
// ProjectProvisionError means completion is not yet known and callers may retry
// the identical request with the same key. Reconciliation, placement,
// compensation, checkpoints, and provider retries are adapter-private.
//
// Remote implementations obtain one-shot SCM credentials from the SCM issuer
// at execution time and deliver their mutable bytes through the compute
// adapter's owner-only secret-file channel. Credentials are never part of this
// request/result contract: they must not be cached, persisted, placed in
// argv/environment/Git configuration, or returned to callers, and both the
// issuer credential and delivered file buffer must be zeroed after use.
type ProjectProvisioner interface {
	Provision(ctx context.Context, request ProjectProvisionRequest) (ProjectProvisionResult, error)
}

// ProjectProvisionError classifies a failed provision only by whether retrying
// the identical request and idempotency key is safe. Err remains in the error
// chain so existing apierr kind/code/details mappings survive this boundary.
// A false Retryable value is a permanent failure.
type ProjectProvisionError struct {
	Retryable bool
	Err       error
}

func (e *ProjectProvisionError) Error() string {
	if e == nil || e.Err == nil {
		return "project provision failed"
	}
	return e.Err.Error()
}

// Unwrap preserves the established service error mapping.
func (e *ProjectProvisionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// ProjectProvisionOperation identifies the existing project creation behavior
// represented by a request.
type ProjectProvisionOperation string

const (
	ProjectProvisionAdd        ProjectProvisionOperation = "add"
	ProjectProvisionClone      ProjectProvisionOperation = "clone"
	ProjectProvisionInitialize ProjectProvisionOperation = "initialize"
)

// ProjectProvisionRequest describes one existing project creation operation.
// Exactly one operation payload must be non-nil and it must match Operation.
// When DefaultBranch is non-empty it is authoritative for materialization. A
// remote adapter may discover it inside compute when omitted, but must never
// inspect a control-plane filesystem checkout to do so.
type ProjectProvisionRequest struct {
	IdempotencyKey string
	Operation      ProjectProvisionOperation
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

// ProjectInitialization is the existing initialize operation result.
type ProjectInitialization struct {
	Path string
}

// ProjectProvisionResult is the final provider-neutral semantic result.
// Project is the shared durable model rather than a cloud-only DTO. Placement
// and all intermediate adapter state remain private. DefaultBranch is the
// materialized repository default; a remote adapter may discover it when the
// request leaves it empty, and downstream code must consume this value without
// probing control-plane filesystem or Git metadata.
type ProjectProvisionResult struct {
	Project        domain.ProjectRecord
	WorkspaceRepos []domain.WorkspaceRepoRecord
	DefaultBranch  string
	Initialization ProjectInitialization
}
