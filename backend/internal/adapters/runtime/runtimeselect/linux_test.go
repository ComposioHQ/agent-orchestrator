package runtimeselect

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestLinuxRuntimeCreatesDirectHandle(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{}
	runtime := newLinuxRuntime(legacy, direct, nil)

	handle, err := runtime.Create(context.Background(), ports.RuntimeConfig{SessionID: "session-1"})
	if err != nil {
		t.Fatal(err)
	}
	if handle.ID != linuxDirectHandlePrefix+"session-1" {
		t.Fatalf("handle = %q, want versioned direct handle", handle.ID)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("legacy calls = %v, want none", legacy.calls)
	}
}

func TestLinuxRuntimeFallsBackToTmuxWhenDirectCreateFails(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{createErr: errors.New("host unavailable")}
	runtime := newLinuxRuntime(legacy, direct, nil)

	handle, err := runtime.Create(context.Background(), ports.RuntimeConfig{SessionID: "session-1"})
	if err != nil {
		t.Fatal(err)
	}
	if handle.ID != "session-1" {
		t.Fatalf("fallback handle = %q, want unprefixed tmux handle", handle.ID)
	}
	if !reflect.DeepEqual(legacy.calls, []string{"create:session-1"}) {
		t.Fatalf("legacy calls = %v", legacy.calls)
	}
}

func TestLinuxRuntimeReportsBothCreationFailures(t *testing.T) {
	directErr := errors.New("host unavailable")
	fallbackErr := errors.New("tmux unavailable")
	legacy := &restartableFakeBackend{fakeBackend: fakeBackend{createErr: fallbackErr}}
	direct := &fakeBackend{createErr: directErr}
	runtime := newLinuxRuntime(legacy, direct, nil)

	_, err := runtime.Create(context.Background(), ports.RuntimeConfig{SessionID: "session-1"})
	if !errors.Is(err, directErr) || !errors.Is(err, fallbackErr) {
		t.Fatalf("Create error = %v, want both direct and fallback failures", err)
	}
}

func TestLinuxRuntimeRoutesPersistedLegacyHandlesToTmux(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{}
	runtime := newLinuxRuntime(legacy, direct, nil)
	ctx := context.Background()
	handle := ports.RuntimeHandle{ID: "existing-session"}
	ref := ports.SupervisedProcessRef{SessionID: domain.SessionID("existing-session"), LaunchID: "launch-1"}

	_ = runtime.Destroy(ctx, handle)
	_, _ = runtime.IsAlive(ctx, handle)
	stream, _ := runtime.Attach(ctx, handle, 24, 80)
	_ = stream.Close()
	_ = runtime.Interrupt(ctx, handle)
	_ = runtime.SendInput(ctx, handle, "x")
	_ = runtime.SendMessage(ctx, handle, "hello")
	_, _ = runtime.GetOutput(ctx, handle, 10)
	_, _ = runtime.GetStyledOutput(ctx, handle, 10)
	_, _ = runtime.IsSupervisedProcessAlive(ctx, handle, ref)
	_, _ = runtime.IsExactSupervisedProcessAlive(ctx, handle, ref)

	wantCalls := []string{"destroy", "alive", "attach", "interrupt", "input", "message", "output", "styled", "supervised", "exact"}
	if !reflect.DeepEqual(legacy.calls, wantCalls) {
		t.Fatalf("legacy calls = %v, want %v", legacy.calls, wantCalls)
	}
	for _, routed := range legacy.handles {
		if routed != handle {
			t.Fatalf("legacy received handle %q, want %q", routed.ID, handle.ID)
		}
	}
	if len(direct.calls) != 0 {
		t.Fatalf("direct calls = %v, want none", direct.calls)
	}
}

func TestLinuxRuntimeRoutesVersionedHandlesToDirectHost(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{}
	runtime := newLinuxRuntime(legacy, direct, nil)
	handle := ports.RuntimeHandle{ID: linuxDirectHandlePrefix + "new-session"}

	if _, err := runtime.GetOutput(context.Background(), handle, 10); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(direct.calls, []string{"output"}) {
		t.Fatalf("direct calls = %v", direct.calls)
	}
	if got := direct.handles[0].ID; got != "new-session" {
		t.Fatalf("direct handle = %q, want stripped session id", got)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("legacy calls = %v, want none", legacy.calls)
	}
}

func TestLinuxRuntimeRestartPreservesBackend(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{}
	runtime := newLinuxRuntime(legacy, direct, nil)
	cfg := ports.RuntimeConfig{SessionID: "session-1"}

	legacyHandle, err := runtime.Restart(context.Background(), ports.RuntimeHandle{ID: "session-1"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if legacyHandle.ID != "session-1" {
		t.Fatalf("legacy restart handle = %q", legacyHandle.ID)
	}
	if !reflect.DeepEqual(legacy.calls, []string{"restart"}) || legacy.handles[0].ID != "session-1" {
		t.Fatalf("legacy restart calls = %v, handles = %v", legacy.calls, legacy.handles)
	}

	directHandle, err := runtime.Restart(context.Background(), ports.RuntimeHandle{ID: linuxDirectHandlePrefix + "session-1"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if directHandle.ID != linuxDirectHandlePrefix+"session-1" {
		t.Fatalf("direct restart handle = %q", directHandle.ID)
	}
	if !reflect.DeepEqual(direct.calls, []string{"destroy", "create:session-1"}) {
		t.Fatalf("direct restart calls = %v", direct.calls)
	}
	if direct.handles[0].ID != "session-1" {
		t.Fatalf("direct destroy handle = %q", direct.handles[0].ID)
	}
}

func TestLinuxRuntimeRestartCanFallBackToTmux(t *testing.T) {
	legacy := &restartableFakeBackend{}
	direct := &fakeBackend{createErr: errors.New("replacement host unavailable")}
	runtime := newLinuxRuntime(legacy, direct, nil)
	cfg := ports.RuntimeConfig{SessionID: "session-1"}

	handle, err := runtime.Restart(context.Background(), ports.RuntimeHandle{
		ID: linuxDirectHandlePrefix + "session-1",
	}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if handle.ID != "session-1" {
		t.Fatalf("fallback handle = %q, want unprefixed tmux handle", handle.ID)
	}
	if !reflect.DeepEqual(direct.calls, []string{"destroy", "create:session-1"}) {
		t.Fatalf("direct calls = %v", direct.calls)
	}
	if !reflect.DeepEqual(legacy.calls, []string{"create:session-1"}) {
		t.Fatalf("legacy calls = %v", legacy.calls)
	}
}
