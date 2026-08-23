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

func gitRun(t *testing.T, root string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=AO Test", "GIT_AUTHOR_EMAIL=ao@example.test",
		"GIT_COMMITTER_NAME=AO Test", "GIT_COMMITTER_EMAIL=ao@example.test",
	)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeMaterializedFile(t *testing.T, root, relative string, body []byte) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func materializedRepo(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	gitRun(t, root, "init", "-b", "main")
	writeMaterializedFile(t, root, "README.md", []byte("before\n"))
	writeMaterializedFile(t, root, "logo.png", []byte("old\x00png"))
	gitRun(t, root, "add", ".")
	gitRun(t, root, "commit", "-m", "initial")
	base := gitRun(t, root, "rev-parse", "HEAD")

	writeMaterializedFile(t, root, "README.md", []byte("after\n"))
	writeMaterializedFile(t, root, "logo.png", []byte("new\x00png"))
	writeMaterializedFile(t, root, "notes.txt", []byte("untracked\n"))
	writeMaterializedFile(t, root, "index.html", []byte("<h1>AO</h1>"))
	return root, base
}

func TestMaterializedObservationImplementsEveryContentOperation(t *testing.T) {
	root, base := materializedRepo(t)
	observation, err := NewMaterializedObservation(MaterializedConfig{
		SessionID: "session-1", Root: root, Branch: "main", DiffBaseSHA: base,
	})
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := observation.Snapshot(context.Background(), ports.WorkspaceInfo{Path: "/control-plane/path"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Path != root || snapshot.HeadSHA == "" || !snapshot.Dirty {
		t.Fatalf("snapshot = %#v", snapshot)
	}

	files, err := observation.ListWorkspaceFiles(context.Background(), "session-1")
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]ports.WorkspaceFileSummary{}
	for _, file := range files.Files {
		byPath[file.Path] = file
	}
	if byPath["README.md"].Status != ports.WorkspaceFileModified || byPath["notes.txt"].Status != ports.WorkspaceFileAdded {
		t.Fatalf("files = %#v", files.Files)
	}

	file, err := observation.ReadWorkspaceFile(context.Background(), "session-1", "README.md")
	if err != nil {
		t.Fatal(err)
	}
	if file.Content != "after\n" || !strings.Contains(file.Diff, "-before") || !strings.Contains(file.Diff, "+after") {
		t.Fatalf("file = %#v", file)
	}

	before, err := observation.ReadWorkspaceBlob(context.Background(), "session-1", "logo.png", ports.WorkspaceBlobBefore)
	if err != nil {
		t.Fatal(err)
	}
	after, err := observation.ReadWorkspaceBlob(context.Background(), "session-1", "logo.png", ports.WorkspaceBlobAfter)
	if err != nil {
		t.Fatal(err)
	}
	if string(before.Data) != "old\x00png" || string(after.Data) != "new\x00png" || before.MediaType != "image/png" {
		t.Fatalf("blobs before=%#v after=%#v", before, after)
	}

	preview, err := observation.ReadPreviewFile(context.Background(), "session-1", "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if string(preview.Data) != "<h1>AO</h1>" || preview.Path != "index.html" {
		t.Fatalf("preview = %#v", preview)
	}
	entry, found, err := observation.DiscoverPreview(context.Background(), "session-1")
	if err != nil || !found || entry != "index.html" {
		t.Fatalf("discover = %q %v %v", entry, found, err)
	}

	observation.InvalidateWorkspace("session-1")
	if _, err := observation.ListWorkspaceFiles(context.Background(), "foreign-session"); err == nil {
		t.Fatal("foreign session content read succeeded")
	}
}

func TestMaterializedObservationWatchAndPreviewConfinement(t *testing.T) {
	root, base := materializedRepo(t)
	observation, err := NewMaterializedObservation(MaterializedConfig{SessionID: "session-1", Root: root, DiffBaseSHA: base})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := observation.WatchWorkspace(ctx, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	writeMaterializedFile(t, root, "watched.txt", []byte("changed"))
	select {
	case <-events:
	case <-time.After(3 * time.Second):
		t.Fatal("workspace change was not observed")
	}

	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := observation.ReadPreviewFile(context.Background(), "session-1", "escape.txt"); err == nil {
		t.Fatal("preview followed a symlink outside the workspace")
	}
}

func TestMaterializedScratchObservation(t *testing.T) {
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	writeMaterializedFile(t, root, "notes.txt", []byte("scratch\n"))
	observation, err := NewMaterializedObservation(MaterializedConfig{SessionID: "session-1", Root: root, Scratch: true})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := observation.Snapshot(context.Background(), ports.WorkspaceInfo{Path: "/ignored"})
	if err != nil || snapshot.Path != root {
		t.Fatalf("snapshot = %#v, err=%v", snapshot, err)
	}
	files, err := observation.ListWorkspaceFiles(context.Background(), "session-1")
	if err != nil || len(files.Files) != 1 || files.Files[0].Status != ports.WorkspaceFileAdded {
		t.Fatalf("files = %#v, err=%v", files, err)
	}
}
