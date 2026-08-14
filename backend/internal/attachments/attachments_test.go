package attachments

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidNameRejectsEscapes(t *testing.T) {
	for _, name := range []string{
		"", ".", "..", "../evil.png", "a/b.png", `a\b.png`, ".hidden",
		"attachment ab.png", "attachment\x00.png", "café.png",
	} {
		if ValidName(name) {
			t.Errorf("ValidName(%q) = true, want false", name)
		}
	}
	for _, name := range []string{"attachment-ab12cd.png", "attachment-1.bin", "legacy_2.JPG"} {
		if !ValidName(name) {
			t.Errorf("ValidName(%q) = false, want true", name)
		}
	}
}

func TestRefNameOnlyAcceptsWorktreeAttachmentRefs(t *testing.T) {
	if name, ok := RefName(".ao/attachments/attachment-ab.png"); !ok || name != "attachment-ab.png" {
		t.Fatalf("RefName = %q/%v", name, ok)
	}
	for _, ref := range []string{
		"attachment-ab.png",                 // no prefix
		".ao/attachments/../secrets.txt",    // traversal
		".ao/attachments/sub/file.png",      // nested
		"src/.ao/attachments/file.png",      // wrong root
		".ao/attachments/",                  // empty name
		".ao/attachmentsevil/attachment.png",
	} {
		if _, ok := RefName(ref); ok {
			t.Errorf("RefName(%q) accepted, want rejected", ref)
		}
	}
}

func TestStoreOpenRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	if err := Store(dataDir, "s1", "attachment-ab.png", []byte("bytes")); err != nil {
		t.Fatalf("Store: %v", err)
	}
	file, info, err := Open(dataDir, "s1", "attachment-ab.png")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = file.Close() }()
	if info.Mode().Perm() != 0o600 {
		t.Errorf("canonical file mode = %v, want 0600", info.Mode().Perm())
	}
	// One session must never resolve another session's files.
	if _, _, err := Open(dataDir, "s2", "attachment-ab.png"); err == nil {
		t.Error("Open under a different session id succeeded, want failure")
	}
	if _, _, err := Open(dataDir, "s1", "../s1/attachment-ab.png"); err == nil {
		t.Error("Open with traversal succeeded, want failure")
	}
}

func TestImportWorktreeSkipsSymlinksAndInvalidNames(t *testing.T) {
	dataDir := t.TempDir()
	worktree := t.TempDir()
	dir := filepath.Join(worktree, ".ao", "attachments")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "attachment-1.png"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(dir, "attachment-2.png")); err != nil {
		t.Fatal(err)
	}

	imported, err := ImportWorktree(dataDir, "s1", worktree)
	if err != nil {
		t.Fatalf("ImportWorktree: %v", err)
	}
	if imported != 1 {
		t.Fatalf("imported = %d, want 1 (symlink skipped)", imported)
	}
	if _, err := os.Stat(filepath.Join(Dir(dataDir, "s1"), "attachment-2.png")); err == nil {
		t.Error("symlinked attachment was imported; links must not pull outside bytes into durable storage")
	}
}

func TestMaterializeDoesNotOverwriteNewerWorktreeCopy(t *testing.T) {
	dataDir := t.TempDir()
	worktree := t.TempDir()
	if err := Store(dataDir, "s1", "attachment-1.png", []byte("old")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(worktree, ".ao", "attachments")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "attachment-1.png"), []byte("newer"), 0o600); err != nil {
		t.Fatal(err)
	}

	copied, err := Materialize(dataDir, "s1", worktree)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if copied != 0 {
		t.Fatalf("copied = %d, want 0", copied)
	}
	got, err := os.ReadFile(filepath.Join(dir, "attachment-1.png"))
	if err != nil || string(got) != "newer" {
		t.Fatalf("worktree copy = %q err=%v, want untouched \"newer\"", got, err)
	}
}
