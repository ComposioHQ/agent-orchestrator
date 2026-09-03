package devin

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAuthStatusAuthorizedFromDocumentedAPIKey(t *testing.T) {
	t.Setenv("DEVIN_API_KEY", "cog_test")
	got, err := (&Plugin{resolvedBinary: "devin"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusAuthorizedFromNativeLogin(t *testing.T) {
	t.Setenv("DEVIN_API_KEY", "")
	previous := authprobe.CmdRunner
	t.Cleanup(func() { authprobe.CmdRunner = previous })
	authprobe.CmdRunner = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "devin" || !reflect.DeepEqual(args, []string{"auth", "status"}) {
			return nil, errors.New("unexpected auth probe command")
		}
		return []byte("Logged in (via Devin)."), nil
	}

	got, err := (&Plugin{resolvedBinary: "devin"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.AgentAuthStatusAuthorized {
		t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusAuthorized)
	}
}
