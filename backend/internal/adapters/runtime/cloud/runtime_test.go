package cloud

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestArchiveWorkspaceIncludesOnlyLocalChanges(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{"tracked.txt": "original", "unchanged.bin": "large tracked asset", ".gitignore": "node_modules/\n.ao/\n"} {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init"}, {"config", "user.email", "test@example.com"}, {"config", "user.name", "Test"}, {"add", "."}, {"commit", "-m", "base"}} {
		command := exec.Command("git", append([]string{"-C", root}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	for name, value := range map[string]string{"tracked.txt": "changed", "untracked.txt": "new", "node_modules/pkg.js": "generated", ".ao/private": "secret"} {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	value, err := archiveWorkspace(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(value))
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(gz)
	names := map[string]bool{}
	for {
		header, nextErr := reader.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		names[header.Name] = true
	}
	for _, included := range []string{"tracked.txt", "untracked.txt"} {
		if !names[included] {
			t.Fatalf("archive is missing local change %q", included)
		}
	}
	for _, excluded := range []string{"unchanged.bin", ".gitignore", "node_modules/pkg.js", ".ao/private"} {
		if names[excluded] {
			t.Fatalf("archive contains %q", excluded)
		}
	}
}

func TestNewRequiresCompleteWorkspaceCapability(t *testing.T) {
	if _, err := New(Options{BaseURL: "https://cloud.example", Token: "token"}); err == nil {
		t.Fatal("missing workspace ID accepted")
	}
	if _, err := New(Options{BaseURL: "file:///tmp", Token: "token", WorkspaceID: "workspace"}); err == nil {
		t.Fatal("non-HTTP URL accepted")
	}
}
