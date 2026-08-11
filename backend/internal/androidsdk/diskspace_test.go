package androidsdk

import (
	"math"
	"path/filepath"
	"testing"
)

func TestFreeBytesReturnsAPlausiblePositiveValue(t *testing.T) {
	free, err := FreeBytes(t.TempDir())
	if err != nil {
		t.Fatalf("FreeBytes: %v", err)
	}
	if free == 0 {
		t.Error("FreeBytes = 0, want a positive value for a real, writable directory")
	}
}

func TestFreeBytesNonexistentPath(t *testing.T) {
	_, err := FreeBytes(filepath.Join(t.TempDir(), "does", "not", "exist"))
	if err == nil {
		t.Fatal("FreeBytes: want an error for a nonexistent path, got nil")
	}
}

func TestCheckDiskSpaceSufficient(t *testing.T) {
	if err := CheckDiskSpace(t.TempDir(), 1); err != nil {
		t.Errorf("CheckDiskSpace(1 byte required): %v, want nil (any real disk has at least 1 free byte)", err)
	}
}

func TestCheckDiskSpaceInsufficient(t *testing.T) {
	// No real disk has this much free space; this must always report insufficient.
	err := CheckDiskSpace(t.TempDir(), math.MaxInt64)
	if err == nil {
		t.Fatal("CheckDiskSpace: want an insufficient-space error, got nil")
	}
}

func TestRequiredDiskSpaceSumsWithHeadroom(t *testing.T) {
	archives := []Archive{{Size: 100}, {Size: 200}, {Size: 300}}
	got := RequiredDiskSpace(archives...)
	// Must budget more than the raw sum: the zip and its extracted contents
	// coexist on disk briefly during install, so raw-sum-or-less is a bug.
	if got <= 600 {
		t.Errorf("RequiredDiskSpace = %d, want more than the raw sum (600) to budget for zip+extracted coexistence", got)
	}
}
