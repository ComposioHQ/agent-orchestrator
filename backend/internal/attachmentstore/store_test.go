package attachmentstore

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestStoreImportsBeforeWorkspaceRemovalAndMaterializesAfterRestore(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "worktree")
	attachmentPath := filepath.Join(workspace, filepath.FromSlash(WorkspaceDir), "attachment-legacy.png")
	if err := os.MkdirAll(filepath.Dir(attachmentPath), 0o750); err != nil {
		t.Fatal(err)
	}
	want := []byte("legacy-image-bytes")
	if err := os.WriteFile(attachmentPath, want, 0o600); err != nil {
		t.Fatal(err)
	}

	store := New(dataDir)
	if err := store.ImportWorkspace("ao-1", workspace); err != nil {
		t.Fatalf("ImportWorkspace: %v", err)
	}
	if err := os.RemoveAll(workspace); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspace, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := store.MaterializeWorkspace("ao-1", workspace); err != nil {
		t.Fatalf("MaterializeWorkspace: %v", err)
	}

	got, err := os.ReadFile(attachmentPath)
	if err != nil {
		t.Fatalf("read restored attachment: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("restored attachment = %q, want %q", got, want)
	}
}

func TestStorePutWritesCanonicalAndWorkspaceCopies(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	store := New(dataDir)
	want := []byte("new-image-bytes")

	if err := store.Put("ao-1", workspace, "attachment-new.png", want); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(workspace, filepath.FromSlash(WorkspaceDir), "attachment-new.png"))
	if err != nil {
		t.Fatalf("read workspace attachment: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("workspace attachment = %q, want %q", got, want)
	}

	file, info, err := store.Open("ao-1", "attachment-new.png")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = file.Close() }()
	if !info.Mode().IsRegular() || info.Size() != int64(len(want)) {
		t.Fatalf("canonical info = %#v", info)
	}
}

func TestNameFromWorkspacePathRejectsTraversal(t *testing.T) {
	tests := []struct {
		path string
		want string
		ok   bool
	}{
		{path: ".ao/attachments/attachment-1.png", want: "attachment-1.png", ok: true},
		{path: "/.ao/attachments/attachment-1.png", want: "attachment-1.png", ok: true},
		{path: ".ao/attachments/../secret", ok: false},
		{path: ".ao/attachments/nested/file.png", ok: false},
		{path: "dist/attachment-1.png", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got, ok := NameFromWorkspacePath(tt.path)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("NameFromWorkspacePath(%q) = %q, %v; want %q, %v", tt.path, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestStoreRejectsUnsafeNamesAndDoesNotImportSymlinks(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	dir := filepath.Join(workspace, filepath.FromSlash(WorkspaceDir))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "attachment-link.png")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	store := New(dataDir)
	if err := store.Put(domain.SessionID("../escape"), workspace, "attachment.png", []byte("x")); err == nil {
		t.Fatal("Put accepted unsafe session id")
	}
	if err := store.Put("ao-1", workspace, "../attachment.png", []byte("x")); err == nil {
		t.Fatal("Put accepted unsafe attachment name")
	}
	if err := store.ImportWorkspace("ao-1", workspace); err != nil {
		t.Fatalf("ImportWorkspace: %v", err)
	}
	if _, _, err := store.Open("ao-1", "attachment-link.png"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Open symlink import error = %v, want not exist", err)
	}
}
