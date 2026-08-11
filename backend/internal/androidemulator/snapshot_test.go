package androidemulator

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFakeSnapshot(t *testing.T, avdDir string) {
	t.Helper()
	dir := filepath.Join(avdDir, "snapshots", "default_boot")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ram.img"), []byte("fake ram snapshot"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureSnapshotValidFirstRunRecordsVersionWithoutClearing(t *testing.T) {
	avdDir := t.TempDir()
	writeFakeSnapshot(t, avdDir)
	want := SnapshotVersion{SystemImageSHA1: "abc123", ProfileHash: "profile-v1"}

	cleared, err := EnsureSnapshotValid(avdDir, want)
	if err != nil {
		t.Fatalf("EnsureSnapshotValid: %v", err)
	}
	// No prior marker exists, so there's nothing proven stale yet -- a
	// snapshot written by a previous, untracked run must not be silently
	// nuked on the very first version-tracked boot.
	if cleared {
		t.Error("cleared = true on first run, want false (nothing to compare against yet)")
	}
	if _, err := os.Stat(filepath.Join(avdDir, "snapshots", "default_boot", "ram.img")); err != nil {
		t.Errorf("snapshot was removed on first run: %v", err)
	}
}

func TestEnsureSnapshotValidSameVersionKeepsSnapshot(t *testing.T) {
	avdDir := t.TempDir()
	writeFakeSnapshot(t, avdDir)
	v := SnapshotVersion{SystemImageSHA1: "abc123", ProfileHash: "profile-v1"}

	if _, err := EnsureSnapshotValid(avdDir, v); err != nil {
		t.Fatalf("first EnsureSnapshotValid: %v", err)
	}
	cleared, err := EnsureSnapshotValid(avdDir, v)
	if err != nil {
		t.Fatalf("second EnsureSnapshotValid: %v", err)
	}
	if cleared {
		t.Error("cleared = true for an unchanged version, want false")
	}
	if _, err := os.Stat(filepath.Join(avdDir, "snapshots", "default_boot", "ram.img")); err != nil {
		t.Errorf("snapshot was removed for an unchanged version: %v", err)
	}
}

func TestEnsureSnapshotValidVersionChangeClearsSnapshot(t *testing.T) {
	avdDir := t.TempDir()
	writeFakeSnapshot(t, avdDir)
	original := SnapshotVersion{SystemImageSHA1: "abc123", ProfileHash: "profile-v1"}
	if _, err := EnsureSnapshotValid(avdDir, original); err != nil {
		t.Fatalf("first EnsureSnapshotValid: %v", err)
	}

	changed := SnapshotVersion{SystemImageSHA1: "def456", ProfileHash: "profile-v1"}
	cleared, err := EnsureSnapshotValid(avdDir, changed)
	if err != nil {
		t.Fatalf("second EnsureSnapshotValid: %v", err)
	}
	if !cleared {
		t.Error("cleared = false after a system-image version change, want true")
	}
	if _, err := os.Stat(filepath.Join(avdDir, "snapshots", "default_boot")); !os.IsNotExist(err) {
		t.Error("stale snapshot directory still exists after a version change")
	}
}
