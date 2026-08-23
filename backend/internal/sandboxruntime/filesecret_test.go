package sandboxruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFileSecretDelivers0600AndPurges(t *testing.T) {
	store, err := NewFileSecret(filepath.Join(t.TempDir(), "secrets"))
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("not-for-argv-or-logs")
	path, err := store.Deliver("provider.json", secret, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(secret) {
		t.Fatalf("read secret = %q, %v", got, err)
	}
	if err := store.Purge(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("secret survived purge: %v", err)
	}
	if err := store.Purge(); err != nil {
		t.Fatalf("second purge: %v", err)
	}
}

func TestFileSecretRejectsTraversalAndBroadModes(t *testing.T) {
	store, err := NewFileSecret(filepath.Join(t.TempDir(), "secrets"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../escape", "nested/file", ""} {
		if _, err := store.Deliver(name, []byte("secret"), 0o600); err == nil {
			t.Fatalf("Deliver accepted %q", name)
		}
	}
	if _, err := store.Deliver("wide", []byte("secret"), 0o640); err == nil {
		t.Fatal("Deliver accepted mode 0640")
	}
}
