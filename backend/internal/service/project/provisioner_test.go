package project_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

func TestServiceDelegatesCreationThroughProjectProvisioner(t *testing.T) {
	t.Parallel()

	projectID := "cloud-project"
	displayName := "Cloud Project"
	config := domain.ProjectConfig{SessionPrefix: "cloud"}
	wantProvision := ports.ProjectProvision{
		State: ports.ProjectProvisionFinalized,
		Project: domain.ProjectRecord{
			ID:            projectID,
			Path:          "/workspaces/cloud-project",
			RepoOriginURL: "https://example.com/acme/cloud-project.git",
			DisplayName:   displayName,
			Kind:          domain.ProjectKindSingleRepo,
			Config:        config,
		},
	}
	fake := &recordingProjectProvisioner{provision: wantProvision}
	service := project.NewWithDeps(project.Deps{Provisioner: fake, DefaultHarness: domain.HarnessCodex})
	ctx := context.Background()

	added, err := service.Add(ctx, project.AddInput{
		Path:      "/input/path",
		ProjectID: &projectID,
		Name:      &displayName,
		Config:    &config,
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	wantAdd := ports.ProjectAddRequest{
		Path:      "/input/path",
		ProjectID: &projectID,
		Name:      &displayName,
		Config:    &config,
	}
	if fake.request.IdempotencyKey == "" || fake.request.Operation != ports.ProjectProvisionAdd || !reflect.DeepEqual(*fake.request.Add, wantAdd) {
		t.Fatalf("Add request = %#v, want payload %#v", fake.request, wantAdd)
	}
	assertProvisionedProject(t, added, wantProvision.Project)

	cloned, err := service.Clone(ctx, project.CloneInput{
		RemoteURL:         wantProvision.Project.RepoOriginURL,
		DestinationParent: "/input/destination",
		ProjectID:         &projectID,
		Name:              &displayName,
		Config:            &config,
	})
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	wantClone := ports.ProjectCloneRequest{
		RemoteURL:         wantProvision.Project.RepoOriginURL,
		DestinationParent: "/input/destination",
		ProjectID:         &projectID,
		Name:              &displayName,
		Config:            &config,
	}
	if fake.request.IdempotencyKey == "" || fake.request.Operation != ports.ProjectProvisionClone || !reflect.DeepEqual(*fake.request.Clone, wantClone) {
		t.Fatalf("Clone request = %#v, want payload %#v", fake.request, wantClone)
	}
	assertProvisionedProject(t, cloned, wantProvision.Project)

	initialized, err := service.InitializeRepository(ctx, project.InitializeRepositoryInput{Path: "/input/init"})
	if err != nil {
		t.Fatalf("InitializeRepository: %v", err)
	}
	if fake.request.IdempotencyKey == "" || fake.request.Operation != ports.ProjectProvisionInitialize || fake.request.Initialize.Path != "/input/init" {
		t.Fatalf("Initialize request = %#v", fake.request)
	}
	if initialized.Path != fake.initialization.Path {
		t.Fatalf("initialized path = %q, want %q", initialized.Path, fake.initialization.Path)
	}
}

func TestProjectProvisionerConformanceLocalAndFakeRemoteReadModel(t *testing.T) {
	ctx := context.Background()
	repository := gitRepo(t)
	projectID := "conformance"
	name := "Conformance"

	local, err := newManager(t).Add(ctx, project.AddInput{Path: repository, ProjectID: &projectID, Name: &name})
	if err != nil {
		t.Fatalf("local Add: %v", err)
	}
	fake := &recordingProjectProvisioner{provision: ports.ProjectProvisionResult{
		State: ports.ProjectProvisionFinalized,
		Project: domain.ProjectRecord{
			ID: projectID, Path: repository, DisplayName: name,
			Kind: domain.ProjectKindSingleRepo,
		},
	}}
	remote, err := project.NewWithDeps(project.Deps{Provisioner: fake}).Add(ctx, project.AddInput{
		Path: repository, ProjectID: &projectID, Name: &name,
	})
	if err != nil {
		t.Fatalf("fake remote Add: %v", err)
	}
	if !reflect.DeepEqual(remote, local) {
		t.Fatalf("fake remote project = %#v, local = %#v", remote, local)
	}
}

func TestServiceProvisioningIdempotencyKeyIsStableAcrossRetries(t *testing.T) {
	fake := &recordingProjectProvisioner{provision: ports.ProjectProvisionResult{
		State:   ports.ProjectProvisionFinalized,
		Project: domain.ProjectRecord{ID: "retry", Path: "/workspaces/retry", Kind: domain.ProjectKindSingleRepo},
	}}
	service := project.NewWithDeps(project.Deps{Provisioner: fake})
	input := project.CloneInput{RemoteURL: "https://example.com/acme/retry.git", ProjectID: ptr("retry")}
	if _, err := service.Clone(context.Background(), input); err != nil {
		t.Fatalf("first Clone: %v", err)
	}
	if _, err := service.Clone(context.Background(), input); err != nil {
		t.Fatalf("retry Clone: %v", err)
	}
	if len(fake.requests) != 2 || fake.requests[0].IdempotencyKey == "" || fake.requests[0].IdempotencyKey != fake.requests[1].IdempotencyKey {
		t.Fatalf("retry keys = %#v", fake.requests)
	}
}

func TestServiceRejectsNonFinalProvisioningOutcome(t *testing.T) {
	fake := &recordingProjectProvisioner{provision: ports.ProjectProvisionResult{
		State: ports.ProjectProvisionRetryPending,
		Retry: &ports.ProjectProvisionRetry{ResumeFrom: ports.ProjectProvisionPlacementProvisioning, Attempts: 1},
	}}
	_, err := project.NewWithDeps(project.Deps{Provisioner: fake}).Clone(context.Background(), project.CloneInput{
		RemoteURL: "https://example.com/acme/retry.git",
	})
	var apiError *apierr.Error
	if !errors.As(err, &apiError) || apiError.Code != "PROJECT_PROVISION_INCOMPLETE" {
		t.Fatalf("Clone error = %v, want PROJECT_PROVISION_INCOMPLETE", err)
	}
}

func assertProvisionedProject(t *testing.T, got project.Project, want domain.ProjectRecord) {
	t.Helper()
	if got.ID != domain.ProjectID(want.ID) || got.Name != want.DisplayName || got.Path != want.Path || got.Repo != want.RepoOriginURL || got.Kind != want.Kind {
		t.Fatalf("project = %#v, want record %#v", got, want)
	}
	if got.Config == nil || !reflect.DeepEqual(*got.Config, want.Config) {
		t.Fatalf("project config = %#v, want %#v", got.Config, want.Config)
	}
}

type recordingProjectProvisioner struct {
	request        ports.ProjectProvisionRequest
	requests       []ports.ProjectProvisionRequest
	provision      ports.ProjectProvision
	initialization ports.ProjectInitialization
}

var _ ports.ProjectProvisioner = (*recordingProjectProvisioner)(nil)

func (f *recordingProjectProvisioner) Provision(_ context.Context, request ports.ProjectProvisionRequest) (ports.ProjectProvisionResult, error) {
	f.request = request
	f.requests = append(f.requests, request)
	result := f.provision
	result.AttemptID = request.IdempotencyKey
	result.IdempotencyKey = request.IdempotencyKey
	result.Operation = request.Operation
	if request.Operation == ports.ProjectProvisionInitialize {
		f.initialization = ports.ProjectInitialization{Path: "/workspaces/initialized"}
		result.Initialization = f.initialization
	}
	return result, nil
}

func (f *recordingProjectProvisioner) Compensate(_ context.Context, request ports.ProjectProvisionCompensation) (ports.ProjectProvisionResult, error) {
	return ports.ProjectProvisionResult{
		AttemptID: request.AttemptID, IdempotencyKey: request.IdempotencyKey,
		State: ports.ProjectProvisionCompensated,
	}, nil
}
