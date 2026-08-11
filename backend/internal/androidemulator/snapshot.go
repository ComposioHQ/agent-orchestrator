package androidemulator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// defaultQuickBootSnapshotName matches the emulator's own default quick-boot
// snapshot name, confirmed from the real qemu command line captured during
// the A0 spike (-mem-path .../snapshots/default_boot/ram.img).
const defaultQuickBootSnapshotName = "default_boot"

// SnapshotVersion fingerprints the inputs that make a saved quick-boot
// snapshot valid. If either changes since the snapshot was last written, the
// snapshot must be discarded and the next boot forced cold -- otherwise the
// emulator could resume RAM state that doesn't match the (now different)
// system image or device profile on disk.
type SnapshotVersion struct {
	SystemImageSHA1 string `json:"systemImageSha1"`
	ProfileHash     string `json:"profileHash"`
}

func versionMarkerPath(avdDir string) string {
	return filepath.Join(avdDir, ".ao-snapshot-version.json")
}

func snapshotDir(avdDir string) string {
	return filepath.Join(avdDir, "snapshots", defaultQuickBootSnapshotName)
}

// EnsureSnapshotValid compares want against the version recorded for avdDir
// (if any). If they differ, any existing quick-boot snapshot is deleted
// (forcing the next boot to go cold) and the marker is updated to want.
//
// A missing marker (first tracked boot of this AVD) does NOT clear an
// existing snapshot -- there is nothing to prove it's stale against, and
// nuking a snapshot nobody asked to invalidate would defeat quick-boot's
// whole purpose on the very first version-tracked run.
func EnsureSnapshotValid(avdDir string, want SnapshotVersion) (cleared bool, err error) {
	existing, hadMarker := readSnapshotVersion(avdDir)
	if hadMarker && existing != want {
		if err := os.RemoveAll(snapshotDir(avdDir)); err != nil && !os.IsNotExist(err) {
			return false, fmt.Errorf("androidemulator: clear stale snapshot: %w", err)
		}
		cleared = true
	}

	if !hadMarker || existing != want {
		if err := writeSnapshotVersion(avdDir, want); err != nil {
			return cleared, err
		}
	}
	return cleared, nil
}

func readSnapshotVersion(avdDir string) (SnapshotVersion, bool) {
	data, err := os.ReadFile(versionMarkerPath(avdDir))
	if err != nil {
		return SnapshotVersion{}, false
	}
	var v SnapshotVersion
	if err := json.Unmarshal(data, &v); err != nil {
		return SnapshotVersion{}, false
	}
	return v, true
}

func writeSnapshotVersion(avdDir string, v SnapshotVersion) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("androidemulator: marshal snapshot version: %w", err)
	}
	if err := os.MkdirAll(avdDir, 0o755); err != nil {
		return fmt.Errorf("androidemulator: mkdir %s: %w", avdDir, err)
	}
	if err := os.WriteFile(versionMarkerPath(avdDir), data, 0o644); err != nil {
		return fmt.Errorf("androidemulator: write snapshot version marker: %w", err)
	}
	return nil
}
