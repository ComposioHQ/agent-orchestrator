package sandboxruntime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWorkspaceObserverMatchesWorkspaceObservationPort(t *testing.T) {
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.name", "AO Test")
	runGit(t, dir, "config", "user.email", "ao@example.invalid")
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "tracked.txt")
	runGit(t, dir, "commit", "-m", "initial")
	if err := os.WriteFile(filepath.Join(dir, "second.txt"), []byte("second\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "second.txt")
	runGit(t, dir, "commit", "-m", "second")
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var observer ports.WorkspaceObserver = WorkspaceObserver{}
	observation, err := observer.ObserveWorkspace(context.Background(), ports.WorkspaceInfo{Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	if observation.Path != dir || observation.Branch != "main" || observation.HeadSHA == "" {
		t.Fatalf("identity observation = %#v", observation)
	}
	if !observation.Dirty || !observation.Untracked || observation.Staged {
		t.Fatalf("workspace flags = dirty:%v staged:%v untracked:%v", observation.Dirty, observation.Staged, observation.Untracked)
	}
	if len(observation.Changes) != 2 || len(observation.Commits) != 2 || observation.Commits[0].Subject != "second" || observation.Commits[1].Subject != "initial" {
		t.Fatalf("bounded facts = %#v", observation)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}
