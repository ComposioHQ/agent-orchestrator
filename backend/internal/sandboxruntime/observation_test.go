package sandboxruntime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

	var observer ports.WorkspaceObservation = &WorkspaceObserver{Root: dir}
	observation, err := observer.Snapshot(context.Background(), ports.WorkspaceInfo{Path: dir})
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

func TestWorkspaceObserverListReadWatchDiffAndBlob(t *testing.T) {
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.name", "AO Test")
	runGit(t, dir, "config", "user.email", "ao@example.invalid")
	tracked := filepath.Join(dir, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "tracked.txt")
	runGit(t, dir, "commit", "-m", "initial")
	observer := &WorkspaceObserver{Root: dir}
	info := ports.WorkspaceInfo{Path: dir}

	listed, err := observer.List(context.Background(), ports.WorkspaceListRequest{Workspaces: []ports.WorkspaceInfo{info}, MaxEntries: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Entries) != 1 || listed.Entries[0].Path != "tracked.txt" {
		t.Fatalf("list = %#v", listed)
	}
	read, err := observer.Read(context.Background(), ports.WorkspaceReadRequest{Workspace: info, Path: "tracked.txt", MaxBytes: 4})
	if err != nil {
		t.Fatal(err)
	}
	if string(read.Data) != "init" || !read.Truncated || read.Size != int64(len("initial\n")) {
		t.Fatalf("read = %#v", read)
	}
	blob, err := observer.Blob(context.Background(), ports.WorkspaceBlobRequest{Workspace: info, Path: "tracked.txt", Revision: "HEAD", MaxBytes: 32})
	if err != nil || string(blob.Data) != "initial\n" {
		t.Fatalf("blob = %#v, %v", blob, err)
	}

	watchCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := observer.Watch(watchCtx, ports.WorkspaceWatchRequest{Workspaces: []ports.WorkspaceInfo{info}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tracked, []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	case <-time.After(3 * time.Second):
		t.Fatal("workspace watch emitted no invalidation")
	}
	diff, err := observer.Diff(context.Background(), ports.WorkspaceDiffRequest{Workspace: info, Base: "HEAD", Path: "tracked.txt", MaxBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff.UnifiedDiff, "+changed") || diff.Truncated {
		t.Fatalf("diff = %#v", diff)
	}
}

func TestWorkspaceObserverConfinesReadsAndBindings(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	observer := &WorkspaceObserver{Root: root}
	for _, path := range []string{"../outside.txt", "escape"} {
		if _, err := observer.Read(context.Background(), ports.WorkspaceReadRequest{Workspace: ports.WorkspaceInfo{Path: root}, Path: path}); err == nil {
			t.Fatalf("read accepted escaping path %q", path)
		}
	}
	if _, err := observer.List(context.Background(), ports.WorkspaceListRequest{Workspaces: []ports.WorkspaceInfo{{Path: t.TempDir()}}}); err == nil {
		t.Fatal("list accepted another workspace")
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}
