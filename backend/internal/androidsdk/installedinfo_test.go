package androidsdk

import "testing"

func TestInstalledSystemImageSHA1WhenInstalled(t *testing.T) {
	toolsDir := t.TempDir()
	if err := writeInstalledManifest(toolsDir, installedManifest{SystemImageSHA1: "abc123"}); err != nil {
		t.Fatal(err)
	}
	sha1, ok := InstalledSystemImageSHA1(toolsDir)
	if !ok {
		t.Fatal("InstalledSystemImageSHA1: ok = false, want true")
	}
	if sha1 != "abc123" {
		t.Errorf("sha1 = %q, want %q", sha1, "abc123")
	}
}

func TestInstalledSystemImageSHA1WhenNotInstalled(t *testing.T) {
	_, ok := InstalledSystemImageSHA1(t.TempDir())
	if ok {
		t.Error("InstalledSystemImageSHA1: ok = true, want false when nothing is installed")
	}
}
