package project

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// localProjectProvisioner preserves the established host-filesystem behavior
// while Service depends only on the provider-neutral provisioning port.
type localProjectProvisioner struct {
	service *Service
}

var _ ports.ProjectProvisioner = localProjectProvisioner{}

func (p localProjectProvisioner) Provision(ctx context.Context, request ports.ProjectProvisionRequest) (ports.ProjectProvisionResult, error) {
	var result ports.ProjectProvisionResult
	var err error
	switch request.Operation {
	case ports.ProjectProvisionAdd:
		if request.Add == nil {
			return result, apierr.Invalid("INVALID_PROJECT_PROVISION", "Project add input is required", nil)
		}
		result, err = p.service.addLocal(ctx, AddInput{
			Path:        request.Add.Path,
			ProjectID:   request.Add.ProjectID,
			Name:        request.Add.Name,
			Config:      request.Add.Config,
			AsWorkspace: request.Add.AsWorkspace,
		})
	case ports.ProjectProvisionClone:
		if request.Clone == nil {
			return result, apierr.Invalid("INVALID_PROJECT_PROVISION", "Project clone input is required", nil)
		}
		result, err = p.service.cloneLocal(ctx, CloneInput{
			RemoteURL:         request.Clone.RemoteURL,
			DestinationParent: request.Clone.DestinationParent,
			ProjectID:         request.Clone.ProjectID,
			Name:              request.Clone.Name,
			Config:            request.Clone.Config,
		})
	case ports.ProjectProvisionInitialize:
		if request.Initialize == nil {
			return result, apierr.Invalid("INVALID_PROJECT_PROVISION", "Project initialization input is required", nil)
		}
		initialized, initializeErr := p.service.initializeRepositoryLocal(ctx, InitializeRepositoryInput{Path: request.Initialize.Path})
		err = initializeErr
		result.Initialization = ports.ProjectInitialization{Path: initialized.Path}
	default:
		return result, apierr.Invalid("INVALID_PROJECT_PROVISION", "Project provisioning operation is invalid", nil)
	}
	if err != nil {
		return ports.ProjectProvisionResult{}, err
	}
	result.AttemptID = request.IdempotencyKey
	result.IdempotencyKey = request.IdempotencyKey
	result.Operation = request.Operation
	result.State = ports.ProjectProvisionFinalized
	return result, nil
}

func (localProjectProvisioner) Compensate(_ context.Context, request ports.ProjectProvisionCompensation) (ports.ProjectProvisionResult, error) {
	// Local Add/Clone/Initialize already roll back their filesystem effects
	// before returning an error, so there is no durable in-flight attempt to
	// clean up after a restart. Reporting compensated is idempotent and does not
	// turn this saga operation into a project-delete API.
	return ports.ProjectProvisionResult{
		AttemptID:      request.AttemptID,
		IdempotencyKey: request.IdempotencyKey,
		State:          ports.ProjectProvisionCompensated,
	}, nil
}

func (m *Service) projectFromProvision(ctx context.Context, provision ports.ProjectProvisionResult) Project {
	project := m.projectFromRow(ctx, provision.Project)
	if provision.Project.Kind.WithDefault() == domain.ProjectKindWorkspace {
		project.WorkspaceRepos = workspaceReposFromRecords(provision.WorkspaceRepos)
	}
	return project
}
