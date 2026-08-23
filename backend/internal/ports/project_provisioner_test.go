package ports

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestProjectProvisionerPublicSurfaceIsMinimal(t *testing.T) {
	t.Parallel()

	provisioner := reflect.TypeOf((*ProjectProvisioner)(nil)).Elem()
	if provisioner.NumMethod() != 1 {
		t.Fatalf("ProjectProvisioner has %d methods, want only Provision", provisioner.NumMethod())
	}
	if method := provisioner.Method(0); method.Name != "Provision" {
		t.Fatalf("ProjectProvisioner method = %q, want Provision", method.Name)
	}

	for _, typ := range []reflect.Type{
		reflect.TypeOf(ProjectProvisionRequest{}),
		reflect.TypeOf(ProjectAddRequest{}),
		reflect.TypeOf(ProjectCloneRequest{}),
		reflect.TypeOf(ProjectInitializeRequest{}),
		reflect.TypeOf(ProjectProvision{}),
		reflect.TypeOf(ProjectPlacement{}),
	} {
		for _, forbidden := range []string{
			"AttemptID", "State", "Checkpoint", "Retry", "ResumeFrom",
			"Compensation", "Undo", "Provider", "Sandbox", "Credential",
			"Credentials", "Token", "Secret", "Secrets", "Password",
		} {
			if _, ok := typ.FieldByName(forbidden); ok {
				t.Errorf("%s exports forbidden saga/provider field %s", typ.Name(), forbidden)
			}
		}
	}
}

func TestProjectProvisionBoundaryCarriesNoCredentialMaterial(t *testing.T) {
	t.Parallel()

	for _, typ := range []reflect.Type{
		reflect.TypeOf(ProjectProvisionRequest{}),
		reflect.TypeOf(ProjectAddRequest{}),
		reflect.TypeOf(ProjectCloneRequest{}),
		reflect.TypeOf(ProjectInitializeRequest{}),
		reflect.TypeOf(ProjectProvision{}),
		reflect.TypeOf(ProjectPlacement{}),
	} {
		for index := 0; index < typ.NumField(); index++ {
			field := typ.Field(index)
			if field.Type == reflect.TypeOf([]byte(nil)) {
				t.Errorf("%s.%s exposes mutable credential bytes", typ.Name(), field.Name)
			}
			if isCredentialField(field.Name) {
				t.Errorf("%s.%s exposes credential material", typ.Name(), field.Name)
			}
		}
	}
}

func TestProjectProvisionerConformanceCarriesDefaultBranch(t *testing.T) {
	t.Parallel()

	for name, provisioner := range map[string]ProjectProvisioner{
		"local":  &conformanceProvisioner{path: "/repos/acme"},
		"remote": &conformanceProvisioner{placementID: "placement-1", path: "/workspace/acme"},
	} {
		t.Run(name, func(t *testing.T) {
			request := ProjectProvisionRequest{
				IdempotencyKey: "create-acme-1",
				DefaultBranch:  "release/2026",
				Clone: &ProjectCloneRequest{
					RemoteURL: "https://example.com/acme/repo.git",
				},
			}
			got, err := provisioner.Provision(context.Background(), request)
			if err != nil {
				t.Fatalf("Provision: %v", err)
			}
			if got.DefaultBranch != request.DefaultBranch {
				t.Fatalf("DefaultBranch = %q, want %q", got.DefaultBranch, request.DefaultBranch)
			}
			if got.Project.Config.DefaultBranch != request.DefaultBranch {
				t.Fatalf("project config DefaultBranch = %q, want %q", got.Project.Config.DefaultBranch, request.DefaultBranch)
			}
			if got.Placement.Path == "" {
				t.Fatal("placement path is empty")
			}
		})
	}
}

func TestProjectProvisionerStableIdempotencyErrors(t *testing.T) {
	t.Parallel()

	for _, sentinel := range []error{
		ErrProjectProvisionIdempotencyConflict,
		ErrProjectProvisionUnavailable,
	} {
		if !errors.Is(fmt.Errorf("adapter context: %w", sentinel), sentinel) {
			t.Fatalf("wrapped sentinel %q is not matchable", sentinel)
		}
	}
}

// conformanceProvisioner intentionally has no filesystem or Git dependency.
// Both local and remote adapters can satisfy the same port while the supplied
// branch remains the only source of default-branch truth at this boundary.
type conformanceProvisioner struct {
	placementID string
	path        string
}

var _ ProjectProvisioner = (*conformanceProvisioner)(nil)

func (p *conformanceProvisioner) Provision(_ context.Context, request ProjectProvisionRequest) (ProjectProvision, error) {
	return ProjectProvision{
		Project: domain.ProjectRecord{
			ID:          "acme",
			Path:        p.path,
			DisplayName: "Acme",
			Kind:        domain.ProjectKindSingleRepo,
			Config:      domain.ProjectConfig{DefaultBranch: request.DefaultBranch},
		},
		Placement:     ProjectPlacement{ID: p.placementID, Path: p.path},
		DefaultBranch: request.DefaultBranch,
	}, nil
}

func isCredentialField(name string) bool {
	for _, marker := range []string{"Credential", "Token", "Secret", "Password"} {
		if strings.Contains(name, marker) {
			return true
		}
	}
	return false
}
