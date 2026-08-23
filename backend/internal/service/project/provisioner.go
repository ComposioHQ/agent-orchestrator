package project

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// localProjectProvisioner preserves the established host-filesystem behavior
// while Service depends only on the provider-neutral provisioning port.
type localProjectProvisioner struct {
	service *Service
}

var _ ports.ProjectProvisioner = localProjectProvisioner{}

func (p localProjectProvisioner) Add(ctx context.Context, request ports.ProjectAddRequest) (ports.ProjectProvision, error) {
	return p.service.addLocal(ctx, AddInput{
		Path:        request.Path,
		ProjectID:   request.ProjectID,
		Name:        request.Name,
		Config:      request.Config,
		AsWorkspace: request.AsWorkspace,
	})
}

func (p localProjectProvisioner) Clone(ctx context.Context, request ports.ProjectCloneRequest) (ports.ProjectProvision, error) {
	return p.service.cloneLocal(ctx, CloneInput{
		RemoteURL:         request.RemoteURL,
		DestinationParent: request.DestinationParent,
		ProjectID:         request.ProjectID,
		Name:              request.Name,
		Config:            request.Config,
	})
}

func (p localProjectProvisioner) InitializeRepository(ctx context.Context, request ports.ProjectInitializeRequest) (ports.ProjectInitialization, error) {
	result, err := p.service.initializeRepositoryLocal(ctx, InitializeRepositoryInput{Path: request.Path})
	if err != nil {
		return ports.ProjectInitialization{}, err
	}
	return ports.ProjectInitialization{Path: result.Path}, nil
}

func (m *Service) projectFromProvision(ctx context.Context, provision ports.ProjectProvision) Project {
	project := m.projectFromRow(ctx, provision.Project)
	if provision.Project.Kind.WithDefault() == domain.ProjectKindWorkspace {
		project.WorkspaceRepos = workspaceReposFromRecords(provision.WorkspaceRepos)
	}
	return project
}
