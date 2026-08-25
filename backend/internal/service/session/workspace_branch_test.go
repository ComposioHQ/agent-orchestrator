package session

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeWorkspaceBranchReader struct {
	branch string
	err    error
	paths  []string
}

func (f *fakeWorkspaceBranchReader) CurrentBranch(_ context.Context, workspacePath string) (string, error) {
	f.paths = append(f.paths, workspacePath)
	return f.branch, f.err
}

func TestGetUsesCurrentWorkspaceBranchInsteadOfSpawnBranch(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata: domain.SessionMetadata{
			Branch:        "ao/mer-1/root",
			WorkspacePath: "/managed/mer/mer-1",
		},
	}
	branches := &fakeWorkspaceBranchReader{branch: "ao/mer-1/fix-346"}
	svc := NewWithDeps(Deps{Store: st, WorkspaceBranches: branches})

	got, err := svc.Get(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Metadata.Branch != "ao/mer-1/fix-346" {
		t.Fatalf("branch = %q, want current workspace branch", got.Metadata.Branch)
	}
	if len(branches.paths) != 1 || branches.paths[0] != "/managed/mer/mer-1" {
		t.Fatalf("branch reader paths = %v", branches.paths)
	}
}

func TestGetRetainsSpawnBranchWhenCurrentBranchCannotBeRead(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata: domain.SessionMetadata{
			Branch:        "ao/mer-1/root",
			WorkspacePath: "/managed/mer/mer-1",
		},
	}
	branches := &fakeWorkspaceBranchReader{err: errors.New("worktree unavailable")}
	svc := NewWithDeps(Deps{Store: st, WorkspaceBranches: branches})

	got, err := svc.Get(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Metadata.Branch != "ao/mer-1/root" {
		t.Fatalf("branch = %q, want durable fallback", got.Metadata.Branch)
	}
}

func TestListUsesCurrentWorkspaceBranchForActiveSessions(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata: domain.SessionMetadata{
			Branch:        "ao/mer-1/root",
			WorkspacePath: "/managed/mer/mer-1",
		},
	}
	branches := &fakeWorkspaceBranchReader{branch: "ao/mer-1/fix-346"}
	svc := NewWithDeps(Deps{Store: st, WorkspaceBranches: branches})

	got, err := svc.List(context.Background(), ListFilter{ProjectID: "mer"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Metadata.Branch != "ao/mer-1/fix-346" {
		t.Fatalf("sessions = %+v, want current workspace branch", got)
	}
}
