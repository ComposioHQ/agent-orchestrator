package sandboxruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishReadyIsAtomicPrivateAndMetadataFree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run", "ready.json")
	if err := PublishReady(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("ready mode = %v", info.Mode())
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"session", "runtime", "workspace", "sandbox", "provider", "url", "id"} {
		if strings.Contains(strings.ToLower(string(body)), forbidden) {
			t.Fatalf("ready signal leaked %q: %s", forbidden, body)
		}
	}
	if string(body) != string(readyPayload) {
		t.Fatalf("ready body = %q", body)
	}
	if err := ClearReady(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("ready signal remained: %v", err)
	}
}

func TestPublishReadyReplacesSymlinkWithoutFollowingIt(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "outside")
	if err := os.WriteFile(target, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "ready.json")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := PublishReady(path); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(target); err != nil || string(body) != "preserve" {
		t.Fatalf("symlink target changed: %q, %v", body, err)
	}
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("published path = %v, %v", info, err)
	}
}
