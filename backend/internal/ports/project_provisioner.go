package ports

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectProvisioner materializes repositories and commits their durable
// project registration. The local adapter works against the host filesystem;
// the hosted adapter works through a coordinator workspace placement. Callers
// consume the same ProjectProvision result in either deployment.
type ProjectProvisioner interface {
	Add(ctx context.Context, request ProjectAddRequest) (ProjectProvision, error)
	Clone(ctx context.Context, request ProjectCloneRequest) (ProjectProvision, error)
	InitializeRepository(ctx context.Context, request ProjectInitializeRequest) (ProjectInitialization, error)
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
// may ignore it because the coordinator placement owns its workspace root.
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

// ProjectProvision is the provider-neutral durable result of Add or Clone.
// Services translate it into their existing HTTP read model; the port does not
// own or duplicate an API DTO.
type ProjectProvision struct {
	Project        domain.ProjectRecord
	WorkspaceRepos []domain.WorkspaceRepoRecord
}
