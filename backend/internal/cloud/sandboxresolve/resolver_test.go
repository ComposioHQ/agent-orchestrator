package sandboxresolve

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type fakeProvider struct {
	sandbox.Provider
}

func TestResolveDockerProvider(t *testing.T) {
	docker := &fakeProvider{}
	resolved, err := New(nil, docker).Resolve(context.Background(), domain.Sandbox{
		Provider: sandbox.ProviderDocker,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved != docker {
		t.Fatal("Resolve() did not return the configured Docker provider")
	}
}

func TestResolveDockerFailsClosedWithoutProvider(t *testing.T) {
	if _, err := New(nil, nil).Resolve(context.Background(), domain.Sandbox{
		Provider: sandbox.ProviderDocker,
	}); err == nil {
		t.Fatal("Resolve() accepted Docker without a configured provider")
	}
}
