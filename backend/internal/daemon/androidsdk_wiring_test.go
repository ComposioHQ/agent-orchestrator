package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnsureAndroidPrefsRootCreatesDirectory covers a real boot failure: the
// Android emulator does not create its own ANDROID_PREFS_ROOT directory. When
// it's missing, the emulator fails immediately with a flood of "Unexpected
// error while creating ... emu-last-feature-flags.protobuf.lock (error: 3)"
// and never reaches the gRPC-ready state, timing out as "crashed".
func TestEnsureAndroidPrefsRootCreatesDirectory(t *testing.T) {
	toolsDir := t.TempDir()
	wantDir := filepath.Join(toolsDir, "android-prefs")

	if _, err := os.Stat(wantDir); !os.IsNotExist(err) {
		t.Fatalf("precondition: %s should not exist yet", wantDir)
	}

	got, err := ensureAndroidPrefsRoot(toolsDir)
	if err != nil {
		t.Fatalf("ensureAndroidPrefsRoot: %v", err)
	}
	if got != wantDir {
		t.Errorf("dir = %q, want %q", got, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Errorf("expected %s to exist as a directory after ensureAndroidPrefsRoot, stat err = %v", wantDir, err)
	}
}

func TestEnsureAndroidPrefsRootIdempotent(t *testing.T) {
	toolsDir := t.TempDir()

	if _, err := ensureAndroidPrefsRoot(toolsDir); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if _, err := ensureAndroidPrefsRoot(toolsDir); err != nil {
		t.Fatalf("second call on an already-existing dir: %v", err)
	}
}
