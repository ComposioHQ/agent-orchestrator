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
	project, err := p.service.addLocal(ctx, AddInput{
		Path:        request.Path,
		ProjectID:   request.ProjectID,
		Name:        request.Name,
		Config:      request.Config,
		AsWorkspace: request.AsWorkspace,
	})
	if err != nil {
		return ports.ProjectProvision{}, err
	}
	return provisionFromProject(project), nil
}

func (p localProjectProvisioner) Clone(ctx context.Context, request ports.ProjectCloneRequest) (ports.ProjectProvision, error) {
	project, err := p.service.cloneLocal(ctx, CloneInput{
		RemoteURL:         request.RemoteURL,
		DestinationParent: request.DestinationParent,
		ProjectID:         request.ProjectID,
		Name:              request.Name,
		Config:            request.Config,
	})
	if err != nil {
		return ports.ProjectProvision{}, err
	}
	return provisionFromProject(project), nil
}

func (p localProjectProvisioner) InitializeRepository(ctx context.Context, request ports.ProjectInitializeRequest) (ports.ProjectInitialization, error) {
	result, err := p.service.initializeRepositoryLocal(ctx, InitializeRepositoryInput{Path: request.Path})
	if err != nil {
		return ports.ProjectInitialization{}, err
	}
	return ports.ProjectInitialization{Path: result.Path}, nil
}

func provisionFromProject(project Project) ports.ProjectProvision {
	config := domain.ProjectConfig{}
	if project.Config != nil {
		config = *project.Config
	}
	repos := make([]domain.WorkspaceRepoRecord, 0, len(project.WorkspaceRepos))
	for _, repo := range project.WorkspaceRepos {
		repos = append(repos, domain.WorkspaceRepoRecord{
			ProjectID:     project.ID,
			Name:          repo.Name,
			RelativePath:  repo.RelativePath,
			RepoOriginURL: repo.Repo,
			GitStatus:     domain.GitStatus(repo.GitStatus),
		})
	}
	return ports.ProjectProvision{
		Project: domain.ProjectRecord{
			ID:            string(project.ID),
			Path:          project.Path,
			RepoOriginURL: project.Repo,
			DisplayName:   project.Name,
			Kind:          project.Kind,
			Config:        config,
		},
		WorkspaceRepos: repos,
	}
}

func (m *Service) projectFromProvision(ctx context.Context, provision ports.ProjectProvision) Project {
	project := m.projectFromRow(ctx, provision.Project)
	if provision.Project.Kind.WithDefault() == domain.ProjectKindWorkspace {
		project.WorkspaceRepos = workspaceReposFromRecords(provision.WorkspaceRepos)
	}
	return project
}
