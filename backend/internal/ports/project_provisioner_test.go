package ports

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
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
		reflect.TypeOf(ProjectProvisionResult{}),
		reflect.TypeOf(ProjectInitialization{}),
	} {
		for _, forbidden := range []string{
			"AttemptID", "State", "Checkpoint", "Retry", "ResumeFrom",
			"Compensation", "Undo", "Provider", "Sandbox", "Placement",
			"Credential",
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
		reflect.TypeOf(ProjectProvisionResult{}),
		reflect.TypeOf(ProjectInitialization{}),
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
		"remote": &conformanceProvisioner{path: "/path/that/does/not/exist/in/control-plane/acme"},
	} {
		t.Run(name, func(t *testing.T) {
			request := ProjectProvisionRequest{
				IdempotencyKey: "create-acme-1",
				Operation:      ProjectProvisionClone,
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
			if got.Project.Path == "" {
				t.Fatal("project path is empty")
			}
		})
	}
}

func TestProjectProvisionErrorClassifiesRetryAndPreservesCause(t *testing.T) {
	t.Parallel()

	cause := apierr.Invalid("NOT_A_GIT_REPO", "existing api error", map[string]any{"path": "/repo"})
	for _, retryable := range []bool{false, true} {
		wrapped := fmt.Errorf("adapter context: %w", &ProjectProvisionError{Retryable: retryable, Err: cause})
		var provisionError *ProjectProvisionError
		if !errors.As(wrapped, &provisionError) || provisionError.Retryable != retryable {
			t.Fatalf("ProjectProvisionError = %#v, want Retryable=%v", provisionError, retryable)
		}
		if !errors.Is(wrapped, cause) {
			t.Fatal("ProjectProvisionError did not preserve its cause")
		}
		var mapped *apierr.Error
		if !errors.As(wrapped, &mapped) || mapped != cause {
			t.Fatalf("mapped api error = %#v, want original %#v", mapped, cause)
		}
		if provisionError.Error() != cause.Error() {
			t.Fatalf("error text = %q, want byte-identical %q", provisionError.Error(), cause.Error())
		}
	}
}

// conformanceProvisioner intentionally has no filesystem or Git dependency.
// Both local and remote adapters can satisfy the same port while the supplied
// branch remains the only source of default-branch truth at this boundary.
type conformanceProvisioner struct {
	path string
}

var _ ProjectProvisioner = (*conformanceProvisioner)(nil)

func (p *conformanceProvisioner) Provision(_ context.Context, request ProjectProvisionRequest) (ProjectProvisionResult, error) {
	return ProjectProvisionResult{
		Project: domain.ProjectRecord{
			ID:          "acme",
			Path:        p.path,
			DisplayName: "Acme",
			Kind:        domain.ProjectKindSingleRepo,
			Config:      domain.ProjectConfig{DefaultBranch: request.DefaultBranch},
		},
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
