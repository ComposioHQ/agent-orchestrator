package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectProvisioner materializes repositories and commits their durable
// project registration. Provision is retry-safe for one IdempotencyKey: a
// hosted implementation resumes the durable attempt instead of creating a
// second project or coordinator placement. The local adapter completes the
// same contract synchronously against the host filesystem.
//
// External sandbox creation and durable project writes are deliberately not
// represented as one transaction. Implementations persist semantic progress
// and return it as ProjectProvisionResult so a retry or reconciler can resume
// or compensate the saga explicitly.
type ProjectProvisioner interface {
	Provision(ctx context.Context, request ProjectProvisionRequest) (ProjectProvisionResult, error)
	Compensate(ctx context.Context, request ProjectProvisionCompensation) (ProjectProvisionResult, error)
}

// ProjectProvisionOperation identifies the existing project API operation a
// provisioner is materializing.
type ProjectProvisionOperation string

const (
	ProjectProvisionAdd        ProjectProvisionOperation = "add"
	ProjectProvisionClone      ProjectProvisionOperation = "clone"
	ProjectProvisionInitialize ProjectProvisionOperation = "initialize"
)

// ProjectProvisionRequest is the provider-neutral command for one provisioning
// saga. Exactly one operation payload is populated. IdempotencyKey identifies
// the user intent across request retries; hosted implementations scope it by
// the tenant carried in context.
type ProjectProvisionRequest struct {
	IdempotencyKey string
	Operation      ProjectProvisionOperation
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
// provisioner uses DestinationParent as a host path. Hosted implementations
// derive the repository location from the coordinator placement.
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

// ProjectInitialization identifies the repository prepared for a subsequent
// Add call.
type ProjectInitialization struct {
	Path string
}

// ProjectProvisionState is a durable saga checkpoint. A hosted adapter records
// a state before performing the corresponding external effect, making retries
// converge after a crash at any boundary.
type ProjectProvisionState string

const (
	ProjectProvisionIntentRecorded        ProjectProvisionState = "intent_recorded"
	ProjectProvisionPlacementProvisioning ProjectProvisionState = "placement_provisioning"
	ProjectProvisionPlacementReady        ProjectProvisionState = "placement_ready"
	ProjectProvisionMaterializing         ProjectProvisionState = "materializing"
	ProjectProvisionFinalizing            ProjectProvisionState = "finalizing"
	ProjectProvisionFinalized             ProjectProvisionState = "finalized"
	ProjectProvisionCompensationPending   ProjectProvisionState = "compensation_pending"
	ProjectProvisionCompensating          ProjectProvisionState = "compensating"
	ProjectProvisionCompensated           ProjectProvisionState = "compensated"
	ProjectProvisionRetryPending          ProjectProvisionState = "retry_pending"
	ProjectProvisionFailed                ProjectProvisionState = "failed"
)

// Terminal reports whether no automatic forward or compensation work remains.
func (s ProjectProvisionState) Terminal() bool {
	return s == ProjectProvisionFinalized || s == ProjectProvisionCompensated || s == ProjectProvisionFailed
}

// ProjectProvisionRetry describes an explicitly scheduled retry. ResumeFrom is
// the last completed semantic checkpoint, not an implementation-specific SQL
// transaction or sandbox command.
type ProjectProvisionRetry struct {
	ResumeFrom ProjectProvisionState
	NotBefore  time.Time
	Attempts   int
}

// ProjectProvisionFailure is safe durable failure context. Code is stable for
// programmatic decisions; Message must not contain credentials or provider
// response bodies.
type ProjectProvisionFailure struct {
	Code    string
	Message string
}

// ProjectProvisionResult is the provider-neutral durable outcome of a saga
// step. Project and WorkspaceRepos are translated into the existing project
// service DTO; they do not define a second HTTP or cloud-only read model.
type ProjectProvisionResult struct {
	AttemptID      string
	IdempotencyKey string
	Operation      ProjectProvisionOperation
	State          ProjectProvisionState
	Project        domain.ProjectRecord
	WorkspaceRepos []domain.WorkspaceRepoRecord
	Initialization ProjectInitialization
	Retry          *ProjectProvisionRetry
	Failure        *ProjectProvisionFailure
}

// ProjectProvision is retained as the concise name used by the local helper
// implementation. It is the same provider-neutral saga result, not another
// model.
type ProjectProvision = ProjectProvisionResult

// ProjectProvisionCompensation requests idempotent cleanup of an unfinished
// attempt. Repeating it after ProjectProvisionCompensated returns the same
// terminal state. A finalized project is not an unfinished attempt and must not
// be deleted through this operation.
type ProjectProvisionCompensation struct {
	AttemptID      string
	IdempotencyKey string
	Reason         string
}
