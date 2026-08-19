package workertransport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
)

func TestWorkspaceListReadWriteStayInsideRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	workspace, err := openWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()

	page, err := workspace.List(worker.WorkspaceListRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first page = %#v", page)
	}
	second, err := workspace.List(worker.WorkspaceListRequest{
		Limit: 10, Cursor: page.NextCursor,
	})
	if err != nil || len(second.Items) != 1 {
		t.Fatalf("second page = %#v, err = %v", second, err)
	}

	file, err := workspace.Read(worker.WorkspaceReadRequest{Path: "README.md"})
	if err != nil || file.Content != "hello\n" {
		t.Fatalf("read = %#v, err = %v", file, err)
	}
	file, err = workspace.Write(worker.WorkspaceWriteRequest{
		Path: "README.md", Content: "updated\n",
	})
	if err != nil || file.Content != "updated\n" {
		t.Fatalf("write = %#v, err = %v", file, err)
	}
	content, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil || string(content) != "updated\n" {
		t.Fatalf("disk content = %q, err = %v", content, err)
	}
}

func TestWorkspaceRejectsTraversalAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	workspace, err := openWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()

	for _, path := range []string{"../secret.txt", "/etc/passwd", "escape/secret.txt"} {
		if _, err := workspace.Read(worker.WorkspaceReadRequest{Path: path}); err == nil {
			t.Fatalf("read %q unexpectedly succeeded", path)
		}
		if _, err := workspace.Write(worker.WorkspaceWriteRequest{
			Path: path, Content: "overwrite",
		}); err == nil {
			t.Fatalf("write %q unexpectedly succeeded", path)
		}
	}
	content, err := os.ReadFile(filepath.Join(outside, "secret.txt"))
	if err != nil || string(content) != "secret" {
		t.Fatalf("outside content = %q, err = %v", content, err)
	}
}

func TestWorkspaceBoundsAndCancellation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "large.txt"),
		[]byte(strings.Repeat("x", maxWorkspaceFile+1)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	workspace, err := openWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	if _, err := workspace.Read(worker.WorkspaceReadRequest{Path: "large.txt"}); err == nil {
		t.Fatal("oversized read unexpectedly succeeded")
	}

	control := &idleControl{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	supervisor := Supervisor{
		Control: control, Workspace: root, PollInterval: 1,
	}
	if err := supervisor.Run(ctx); err != nil {
		t.Fatalf("cancelled supervisor returned %v", err)
	}
}

type idleControl struct{}

func (*idleControl) ClaimTransport(ctx context.Context) (*worker.TransportRequest, error) {
	return nil, ctx.Err()
}
func (*idleControl) ClaimTurn(ctx context.Context) (*worker.Turn, error) {
	return nil, ctx.Err()
}
func (*idleControl) CompleteTurn(context.Context, string, int, bool) error     { return nil }
func (*idleControl) FailTurn(context.Context, string, int, string) error       { return nil }
func (*idleControl) CompleteTransport(context.Context, string, int, any) error { return nil }
func (*idleControl) FailTransport(context.Context, string, int, string, string) error {
	return nil
}
func (*idleControl) PublishTerminalOutput(context.Context, string, []byte) error {
	return errors.New("unexpected output")
}
func (*idleControl) PublishTerminalExit(context.Context, string, int) error {
	return nil
}
