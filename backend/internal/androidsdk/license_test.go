package androidsdk

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteLicenseHashWritesSHA256HexOfText(t *testing.T) {
	dir := t.TempDir()
	text := "Terms and Conditions\n\nSample license body for the test."

	if err := WriteLicenseHash(dir, "android-sdk-license", text); err != nil {
		t.Fatalf("WriteLicenseHash: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dir, "android-sdk-license"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	sum := sha256.Sum256([]byte(text))
	want := hex.EncodeToString(sum[:])
	if string(got) != want {
		t.Errorf("license hash file content = %q, want %q", got, want)
	}
}

func TestWriteLicenseHashCreatesLicensesDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "licenses")
	if err := WriteLicenseHash(dir, "android-sdk-license", "text"); err != nil {
		t.Fatalf("WriteLicenseHash: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "android-sdk-license")); err != nil {
		t.Errorf("license file not created: %v", err)
	}
}
