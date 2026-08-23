package sandboxruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileCapabilityRequiresRawRegular0600File(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capability")
	if err := os.WriteFile(path, []byte("opaque-capability"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := (FileCapability{Path: path}).ReadCapability()
	if err != nil || string(got) != "opaque-capability" {
		t.Fatalf("ReadCapability = %q, %v", got, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (FileCapability{Path: path}).ReadCapability(); err == nil {
		t.Fatal("world-readable capability was accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "target"), path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "target"), []byte("opaque"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (FileCapability{Path: path}).ReadCapability(); err == nil {
		t.Fatal("symlink capability was accepted")
	}
}

func TestFileCapabilityRejectsEmptyOversizedAndHeaderBreakingValues(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":     {},
		"oversized": []byte(strings.Repeat("x", maxCapabilityBytes+1)),
		"newline":   []byte("opaque\n"),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "capability")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := (FileCapability{Path: path}).ReadCapability(); err == nil {
				t.Fatalf("accepted %s capability", name)
			}
		})
	}
}

func TestControlPlaneRedeemerRequiresVerifiedTLSBaseURL(t *testing.T) {
	for _, endpoint := range []string{"http://control.example", "https://token@control.example", "not a URL"} {
		if _, err := NewControlPlaneRedeemer(endpoint, FileCapability{Path: "/unused"}, testTarget()); err == nil {
			t.Fatalf("accepted control plane URL %q", endpoint)
		}
	}
}
