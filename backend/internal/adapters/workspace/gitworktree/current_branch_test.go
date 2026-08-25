package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCurrentBranchReadsManagedWorktreeSymbolicRef(t *testing.T) {
	managedRoot := t.TempDir()
	workspacePath := filepath.Join(managedRoot, "mer", "mer-1")
	if err := os.MkdirAll(workspacePath, 0o755); err != nil {
		t.Fatal(err)
	}
	var gotArgs []string
	w := &Workspace{
		binary:      "git",
		managedRoot: managedRoot,
		run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			gotArgs = append([]string(nil), args...)
			return []byte("ao/mer-1/fix-346\n"), nil
		},
	}

	got, err := w.CurrentBranch(context.Background(), workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ao/mer-1/fix-346" {
		t.Fatalf("branch = %q", got)
	}
	wantArgs := []string{"-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("git args = %q, want %q", gotArgs, wantArgs)
	}
}

func TestCurrentBranchRejectsPathOutsideManagedRoot(t *testing.T) {
	managedRoot := t.TempDir()
	outside := t.TempDir()
	runCalled := false
	w := &Workspace{
		binary:      "git",
		managedRoot: managedRoot,
		run: func(context.Context, string, ...string) ([]byte, error) {
			runCalled = true
			return nil, nil
		},
	}

	_, err := w.CurrentBranch(context.Background(), outside)
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("err = %v, want ErrUnsafePath", err)
	}
	if runCalled {
		t.Fatal("git must not run for a path outside ManagedRoot")
	}
}
