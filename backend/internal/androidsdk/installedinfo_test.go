package androidsdk

import "testing"

func TestInstalledReturnsAOManagedWhenManifestPresent(t *testing.T) {
	toolsDir := t.TempDir()
	m := installedManifest{SystemImageSHA1: "abc123", APILevel: 34, Tag: "google_apis", ABI: "x86_64"}
	if err := writeInstalledManifest(toolsDir, m); err != nil {
		t.Fatal(err)
	}

	sdk, ok := Installed(toolsDir)
	if !ok {
		t.Fatal("Installed: ok = false, want true")
	}
	want := InstalledSDK{Source: SourceAOManaged, Root: Dir(toolsDir), APILevel: 34, Tag: "google_apis", ABI: "x86_64", VersionKey: "abc123"}
	if sdk != want {
		t.Errorf("Installed = %+v, want %+v", sdk, want)
	}
}

func TestInstalledNotOkWhenNothingPresent(t *testing.T) {
	if _, ok := Installed(t.TempDir()); ok {
		t.Error("Installed: ok = true, want false when nothing is installed")
	}
}

func TestInstalledReturnsExternalWhenMarkerPresentAndValid(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 34, "google_apis", "x86_64")

	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64", RelPath: "system-images/android-34/google_apis/x86_64/"}}
	if err := writeExternalSDKRecord(toolsDir, d); err != nil {
		t.Fatal(err)
	}

	sdk, ok := Installed(toolsDir)
	if !ok {
		t.Fatal("Installed: ok = false, want true")
	}
	if sdk.Source != SourceExternal || sdk.Root != extRoot || sdk.APILevel != 34 || sdk.Tag != "google_apis" || sdk.ABI != "x86_64" {
		t.Errorf("Installed = %+v, want Source=%q Root=%q APILevel=34 Tag=google_apis ABI=x86_64", sdk, SourceExternal, extRoot)
	}
	if sdk.VersionKey == "" {
		t.Error("Installed: VersionKey is empty, want a non-empty version fingerprint")
	}
}

func TestInstalledNotOkWhenExternalMarkerStale(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir() // marker will point here, but nothing is actually on disk

	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}
	if err := writeExternalSDKRecord(toolsDir, d); err != nil {
		t.Fatal(err)
	}

	if _, ok := Installed(toolsDir); ok {
		t.Error("Installed: ok = true, want false when the recorded external SDK no longer exists on disk")
	}
}

func TestInstalledAOManagedWinsWhenBothPresent(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 30, "default", "x86_64")

	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 30, Tag: "default", ABI: "x86_64"}}
	if err := writeExternalSDKRecord(toolsDir, d); err != nil {
		t.Fatal(err)
	}
	m := installedManifest{SystemImageSHA1: "managed-sha1", APILevel: 34, Tag: "google_apis", ABI: "x86_64"}
	if err := writeInstalledManifest(toolsDir, m); err != nil {
		t.Fatal(err)
	}

	sdk, ok := Installed(toolsDir)
	if !ok {
		t.Fatal("Installed: ok = false, want true")
	}
	if sdk.Source != SourceAOManaged {
		t.Errorf("Source = %q, want %q (ao_managed must win when both are present)", sdk.Source, SourceAOManaged)
	}
}
