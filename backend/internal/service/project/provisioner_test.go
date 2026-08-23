package project_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

func TestServiceDelegatesCreationThroughProjectProvisioner(t *testing.T) {
	t.Parallel()

	projectID := "cloud-project"
	displayName := "Cloud Project"
	config := domain.ProjectConfig{SessionPrefix: "cloud"}
	wantProvision := ports.ProjectProvision{
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
	if !reflect.DeepEqual(fake.addRequest, wantAdd) {
		t.Fatalf("Add request = %#v, want %#v", fake.addRequest, wantAdd)
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
	if !reflect.DeepEqual(fake.cloneRequest, wantClone) {
		t.Fatalf("Clone request = %#v, want %#v", fake.cloneRequest, wantClone)
	}
	assertProvisionedProject(t, cloned, wantProvision.Project)

	initialized, err := service.InitializeRepository(ctx, project.InitializeRepositoryInput{Path: "/input/init"})
	if err != nil {
		t.Fatalf("InitializeRepository: %v", err)
	}
	if fake.initializeRequest.Path != "/input/init" {
		t.Fatalf("Initialize request path = %q", fake.initializeRequest.Path)
	}
	if initialized.Path != fake.initialization.Path {
		t.Fatalf("initialized path = %q, want %q", initialized.Path, fake.initialization.Path)
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
	addRequest        ports.ProjectAddRequest
	cloneRequest      ports.ProjectCloneRequest
	initializeRequest ports.ProjectInitializeRequest
	provision         ports.ProjectProvision
	initialization    ports.ProjectInitialization
}

var _ ports.ProjectProvisioner = (*recordingProjectProvisioner)(nil)

func (f *recordingProjectProvisioner) Add(_ context.Context, request ports.ProjectAddRequest) (ports.ProjectProvision, error) {
	f.addRequest = request
	return f.provision, nil
}

func (f *recordingProjectProvisioner) Clone(_ context.Context, request ports.ProjectCloneRequest) (ports.ProjectProvision, error) {
	f.cloneRequest = request
	return f.provision, nil
}

func (f *recordingProjectProvisioner) InitializeRepository(_ context.Context, request ports.ProjectInitializeRequest) (ports.ProjectInitialization, error) {
	f.initializeRequest = request
	f.initialization = ports.ProjectInitialization{Path: "/workspaces/initialized"}
	return f.initialization, nil
}
