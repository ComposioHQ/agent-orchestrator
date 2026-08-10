package systemcheck

import (
	"context"
	"errors"
	"testing"

	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type fakeHarnessCatalog struct {
	inventory agentsvc.Inventory
	err       error
}

func (f *fakeHarnessCatalog) Refresh(context.Context) (agentsvc.Inventory, error) {
	return f.inventory, f.err
}

func lookPathFound(paths map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if p, ok := paths[name]; ok {
			return p, nil
		}
		return "", errors.New("exec: " + name + ": executable file not found in $PATH")
	}
}

func TestCheck_AllSatisfied(t *testing.T) {
	catalog := &fakeHarnessCatalog{inventory: agentsvc.Inventory{
		Installed: []agentsvc.Info{{ID: "claude-code", Label: "Claude Code"}},
	}}
	svc := NewWithLookPath(catalog, lookPathFound(map[string]string{
		"git":  "/usr/bin/git",
		"tmux": "/usr/bin/tmux",
	}))

	report, err := svc.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if !report.Ready {
		t.Fatalf("Ready = false, want true; requirements=%+v", report.Requirements)
	}
	if len(report.Requirements) != 3 {
		t.Fatalf("len(Requirements) = %d, want 3", len(report.Requirements))
	}
	wantOrder := []string{"git", "tmux", "harness"}
	for i, id := range wantOrder {
		if report.Requirements[i].ID != id {
			t.Fatalf("Requirements[%d].ID = %q, want %q", i, report.Requirements[i].ID, id)
		}
		if !report.Requirements[i].Satisfied {
			t.Fatalf("Requirements[%d] (%s) not satisfied", i, id)
		}
	}
}

func TestCheck_GitMissing(t *testing.T) {
	catalog := &fakeHarnessCatalog{inventory: agentsvc.Inventory{
		Installed: []agentsvc.Info{{ID: "claude-code", Label: "Claude Code"}},
	}}
	svc := NewWithLookPath(catalog, lookPathFound(map[string]string{
		"tmux": "/usr/bin/tmux",
	}))

	report, err := svc.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if report.Ready {
		t.Fatalf("Ready = true, want false")
	}
	git := requirementByID(t, report, "git")
	if git.Satisfied {
		t.Fatalf("git.Satisfied = true, want false")
	}
	if git.Detail == "" {
		t.Fatalf("git.Detail is empty, want a not-found message")
	}
	if tmux := requirementByID(t, report, "tmux"); !tmux.Satisfied {
		t.Fatalf("tmux.Satisfied = false, want true")
	}
}

func TestCheck_TmuxMissing(t *testing.T) {
	catalog := &fakeHarnessCatalog{inventory: agentsvc.Inventory{
		Installed: []agentsvc.Info{{ID: "claude-code", Label: "Claude Code"}},
	}}
	svc := NewWithLookPath(catalog, lookPathFound(map[string]string{
		"git": "/usr/bin/git",
	}))

	report, err := svc.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if report.Ready {
		t.Fatalf("Ready = true, want false")
	}
	tmux := requirementByID(t, report, "tmux")
	if tmux.Satisfied {
		t.Fatalf("tmux.Satisfied = true, want false")
	}
	if tmux.Detail == "" {
		t.Fatalf("tmux.Detail is empty, want a not-found message")
	}
}

func TestCheck_NoHarnessInstalled(t *testing.T) {
	catalog := &fakeHarnessCatalog{inventory: agentsvc.Inventory{Installed: nil}}
	svc := NewWithLookPath(catalog, lookPathFound(map[string]string{
		"git":  "/usr/bin/git",
		"tmux": "/usr/bin/tmux",
	}))

	report, err := svc.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if report.Ready {
		t.Fatalf("Ready = true, want false")
	}
	harness := requirementByID(t, report, "harness")
	if harness.Satisfied {
		t.Fatalf("harness.Satisfied = true, want false")
	}
	if harness.Detail == "" {
		t.Fatalf("harness.Detail is empty, want a not-found message")
	}
}

func TestCheck_HarnessCatalogError(t *testing.T) {
	catalog := &fakeHarnessCatalog{err: errors.New("probe boom")}
	svc := NewWithLookPath(catalog, lookPathFound(map[string]string{
		"git":  "/usr/bin/git",
		"tmux": "/usr/bin/tmux",
	}))

	report, err := svc.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v, want nil (harness errors fold into the requirement)", err)
	}
	if report.Ready {
		t.Fatalf("Ready = true, want false")
	}
	harness := requirementByID(t, report, "harness")
	if harness.Satisfied {
		t.Fatalf("harness.Satisfied = true, want false")
	}
	if harness.Detail != "probe boom" {
		t.Fatalf("harness.Detail = %q, want %q", harness.Detail, "probe boom")
	}
}

func TestCheck_ContextAlreadyDone(t *testing.T) {
	catalog := &fakeHarnessCatalog{}
	svc := NewWithLookPath(catalog, lookPathFound(nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := svc.Check(ctx)
	if err == nil {
		t.Fatalf("Check() error = nil, want context.Canceled")
	}
}

func requirementByID(t *testing.T, report Report, id string) Requirement {
	t.Helper()
	for _, req := range report.Requirements {
		if req.ID == id {
			return req
		}
	}
	t.Fatalf("no requirement with id %q in %+v", id, report.Requirements)
	return Requirement{}
}
