package cursor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeCursorUsagePlugin struct {
	binary string
	auth   ports.AgentAuthStatus
}

func (f fakeCursorUsagePlugin) ResolveBinary(context.Context) (string, error) { return f.binary, nil }
func (f fakeCursorUsagePlugin) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return f.auth, nil
}

func TestNormalizeCursorSubscriptionUsage(t *testing.T) {
	observedAt := time.Date(2026, 8, 24, 4, 1, 34, 0, time.UTC)
	observation, err := normalizeCursorSubscriptionUsage(rawCursorUsage{
		PlanName: "Pro+", ResetLabel: "Resets Aug 25",
		Included: &rawIncludedUsage{TotalPercentUsed: float64Ptr(21), AutoPercentUsed: float64Ptr(10), APIPercentUsed: float64Ptr(100)},
		OnDemand: &rawOnDemandUsage{Kind: "fixed", UsedDollars: float64Ptr(333.68), LimitDollars: float64Ptr(1)},
	}, observedAt)
	if err != nil {
		t.Fatal(err)
	}
	if observation.Plan == nil || *observation.Plan != "Pro+" || len(observation.Limits) != 4 {
		t.Fatalf("observation = %+v", observation)
	}
	if got := observation.Limits[2].UsedPercent; got == nil || *got != 100 {
		t.Fatalf("API percentage = %v", got)
	}
	spend := observation.Limits[3]
	if spend.State != domain.SubscriptionLimitActive || spend.RemainingValue == nil || *spend.RemainingValue != 0 {
		t.Fatalf("spend = %+v", spend)
	}
	if observation.Limits[0].ResetsAt == nil || !observation.Limits[0].ResetsAt.Equal(time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("reset = %v", observation.Limits[0].ResetsAt)
	}
}

func TestCursorSubscriptionUsageRejectsAPIKeyModeBeforePrivateProtocol(t *testing.T) {
	t.Setenv("CURSOR_API_KEY", "secret")
	reader := NewSubscriptionUsageReader(fakeCursorUsagePlugin{binary: "/cursor-agent", auth: ports.AgentAuthStatusAuthorized})
	reader.readBuild = func(context.Context, string) (string, error) {
		t.Fatal("API-key mode must not probe the private dashboard protocol")
		return "", nil
	}
	_, err := reader.ReadSubscriptionUsage(context.Background())
	if !errors.Is(err, ports.ErrSubscriptionUsageUnsupported) {
		t.Fatalf("error = %v", err)
	}
}

func TestCursorUsageProtocolAcceptsOnlyVerifiedBuilds(t *testing.T) {
	for _, build := range []string{"2026.08.11-e8db854", "2026.08.25-3e8eec8"} {
		if _, err := newCursorUsageClient("cursor-agent", build, "/runtime", nil); err != nil {
			t.Fatalf("verified build %s rejected: %v", build, err)
		}
	}
	if _, err := newCursorUsageClient("cursor-agent", "2026.09.01-unknown", "/runtime", nil); !errors.Is(err, errCursorUsageBuildUnsupported) {
		t.Fatalf("unknown build error = %v", err)
	}
}

func TestCursorUsageProtocolDecodesOnlySanitizedUsage(t *testing.T) {
	runner := func(context.Context, string, string, string) ([]byte, error) {
		return []byte(`{"cliVersion":"2026.08.25-3e8eec8","usage":{"kind":"available","model":{"kind":"standard","planName":"Pro+","resetLabel":"Resets Sep 25","included":{"totalPercentUsed":21},"onDemand":{"kind":"fixed","usedDollars":3,"limitDollars":10}}}}`), nil
	}
	client, err := newCursorUsageClient("cursor-agent", "2026.08.25-3e8eec8", "/runtime", runner)
	if err != nil {
		t.Fatal(err)
	}
	usage, err := client.ReadUsage(context.Background())
	if err != nil || usage.PlanName != "Pro+" || usage.Included == nil || usage.OnDemand == nil {
		t.Fatalf("usage = %#v, err = %v", usage, err)
	}
}

func TestCursorUsageRunnerCapsOutputAndEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	for name, fixture := range map[string]struct {
		contents string
		mode     os.FileMode
	}{
		"cursor-agent": {contents: "fixture", mode: 0o600},
		"node":         {contents: "#!/bin/sh\nhead -c 70000 /dev/zero\n", mode: 0o700},
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(fixture.contents), fixture.mode); err != nil {
			t.Fatal(err)
		}
	}
	runtimeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(runtimeDir, "ao-cursor-subscription-usage.cjs"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := runCursorUsageHelper(context.Background(), filepath.Join(dir, "cursor-agent"), "2026.08.25-3e8eec8", runtimeDir)
	if err == nil || !strings.Contains(err.Error(), "oversized") {
		t.Fatalf("error = %v, want bounded output failure", err)
	}
	env := strings.Join(cursorUsageHelperEnv([]string{"HOME=/home/me", "CURSOR_DATA_DIR=/profile", "CURSOR_API_KEY=secret", "OTHER=value"}), "\n")
	if !strings.Contains(env, "HOME=/home/me") || !strings.Contains(env, "CURSOR_DATA_DIR=/profile") || strings.Contains(env, "secret") || strings.Contains(env, "OTHER=") {
		t.Fatalf("filtered environment = %q", env)
	}
}

func float64Ptr(value float64) *float64 { return &value }
