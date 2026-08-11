package androidsdk

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// installTestServer builds a real httptest server serving fixture manifests
// and zip archives, mirroring the real dl.google.com layout confirmed during
// the A0 spike: platform-tools/emulator live at the repository root, system
// images live under a per-tag sys-img subdirectory.
func installTestServer(t *testing.T) (srv *httptest.Server, cfg InstallConfig, manifestFetches, downloadCalls *int) {
	t.Helper()

	ptZip := zipBytes(t, map[string]string{"platform-tools/adb.exe": "fake adb"})
	emuZip := zipBytes(t, map[string]string{"emulator/emulator.exe": "fake emulator"})
	sysZip := zipBytes(t, map[string]string{"x86_64/system.img": "fake system image"})

	licenseText := "Sample Android SDK license text for the test."

	repoManifest := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/3">
  <license id="android-sdk-license" type="text">%s</license>
  <channel id="channel-0">stable</channel>
  <remotePackage path="platform-tools">
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives><archive><complete><size>%d</size><checksum type="sha1">%s</checksum><url>platform-tools.zip</url></complete><host-os>windows</host-os></archive></archives>
  </remotePackage>
  <remotePackage path="emulator">
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives><archive><complete><size>%d</size><checksum type="sha1">%s</checksum><url>emulator.zip</url></complete><host-os>windows</host-os><host-arch>x64</host-arch></archive></archives>
  </remotePackage>
</sdk:sdk-repository>`, licenseText, len(ptZip), sha1Hex(ptZip), len(emuZip), sha1Hex(emuZip))

	sysimgManifest := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-sys-img xmlns:sdk="http://schemas.android.com/sdk/android/repo/sys-img2/3">
  <license id="android-sdk-license" type="text">%s</license>
  <channel id="channel-0">stable</channel>
  <remotePackage path="system-images;android-34;google_apis;x86_64">
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives><archive><complete><size>%d</size><checksum type="sha1">%s</checksum><url>sysimg.zip</url></complete></archive></archives>
  </remotePackage>
</sdk:sdk-sys-img>`, licenseText, len(sysZip), sha1Hex(sysZip))

	manifestCalls := 0
	dlCalls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/repository2-3.xml", func(w http.ResponseWriter, r *http.Request) {
		manifestCalls++
		w.Write([]byte(repoManifest))
	})
	mux.HandleFunc("/sys-img/google_apis/sys-img2-3.xml", func(w http.ResponseWriter, r *http.Request) {
		manifestCalls++
		w.Write([]byte(sysimgManifest))
	})
	mux.HandleFunc("/platform-tools.zip", func(w http.ResponseWriter, r *http.Request) { dlCalls++; w.Write(ptZip) })
	mux.HandleFunc("/emulator.zip", func(w http.ResponseWriter, r *http.Request) { dlCalls++; w.Write(emuZip) })
	mux.HandleFunc("/sys-img/google_apis/sysimg.zip", func(w http.ResponseWriter, r *http.Request) { dlCalls++; w.Write(sysZip) })
	srv = httptest.NewServer(mux)

	cfg = InstallConfig{
		Client:                srv.Client(),
		RepositoryManifestURL: srv.URL + "/repository2-3.xml",
		SysImgManifestURL:     srv.URL + "/sys-img/google_apis/sys-img2-3.xml",
		DownloadBaseURL:       srv.URL + "/",
		SysImgDownloadBaseURL: srv.URL + "/sys-img/google_apis/",
		ToolsDir:              filepath.Join(t.TempDir(), "tools"),
		Platform:              Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"},
		APILevel:              34,
		Tag:                   "google_apis",
		AcceptLicenses:        true,
	}
	return srv, cfg, &manifestCalls, &dlCalls
}

func TestInstallDownloadsVerifiesAndUnpacksAllComponents(t *testing.T) {
	srv, cfg, _, _ := installTestServer(t)
	defer srv.Close()

	if err := Install(context.Background(), cfg); err != nil {
		t.Fatalf("Install: %v", err)
	}

	adb, err := os.ReadFile(filepath.Join(PlatformToolsDir(cfg.ToolsDir), "adb.exe"))
	if err != nil {
		t.Fatalf("read extracted adb.exe: %v", err)
	}
	if string(adb) != "fake adb" {
		t.Errorf("adb.exe content = %q, want %q", adb, "fake adb")
	}

	emu, err := os.ReadFile(filepath.Join(EmulatorDir(cfg.ToolsDir), "emulator.exe"))
	if err != nil {
		t.Fatalf("read extracted emulator.exe: %v", err)
	}
	if string(emu) != "fake emulator" {
		t.Errorf("emulator.exe content = %q, want %q", emu, "fake emulator")
	}

	sysImg, err := os.ReadFile(filepath.Join(SystemImageDir(cfg.ToolsDir, 34, "google_apis", "x86_64"), "system.img"))
	if err != nil {
		t.Fatalf("read extracted system.img: %v", err)
	}
	if string(sysImg) != "fake system image" {
		t.Errorf("system.img content = %q, want %q", sysImg, "fake system image")
	}

	if _, err := os.Stat(filepath.Join(LicensesDir(cfg.ToolsDir), "android-sdk-license")); err != nil {
		t.Errorf("license hash file not written: %v", err)
	}

	if _, err := os.Stat(ManifestPath(cfg.ToolsDir)); err != nil {
		t.Errorf("version manifest not written: %v", err)
	}
}

func TestInstallRequiresAcceptLicenses(t *testing.T) {
	srv, cfg, manifestCalls, dlCalls := installTestServer(t)
	defer srv.Close()
	cfg.AcceptLicenses = false

	err := Install(context.Background(), cfg)
	if err == nil {
		t.Fatal("Install: want an error when AcceptLicenses is false, got nil")
	}
	if *manifestCalls != 0 || *dlCalls != 0 {
		t.Errorf("server was contacted (manifest=%d, download=%d) without license consent, want 0 for both", *manifestCalls, *dlCalls)
	}
	if _, statErr := os.Stat(cfg.ToolsDir); !os.IsNotExist(statErr) {
		t.Error("ToolsDir was created without license consent, want it absent")
	}
}

func TestInstallSecondCallIsIdempotentNoOp(t *testing.T) {
	srv, cfg, manifestCalls, dlCalls := installTestServer(t)
	defer srv.Close()

	if err := Install(context.Background(), cfg); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	if *dlCalls != 3 {
		t.Fatalf("first Install made %d download requests, want 3 (platform-tools, emulator, system-image)", *dlCalls)
	}

	if err := Install(context.Background(), cfg); err != nil {
		t.Fatalf("second Install: %v", err)
	}
	// Re-checking the manifest on every call (to detect a version bump) is
	// correct and expected -- it's small, cheap XML. What must NOT repeat is
	// the ~2GB of archive downloads, which the version-matched idempotency
	// check should skip entirely.
	if *dlCalls != 3 {
		t.Errorf("second Install made %d total download requests, want still 3 (no re-download of an already-installed matching version)", *dlCalls)
	}
	if *manifestCalls == 0 {
		t.Error("second Install never re-checked the manifest, want it to (cheap, and needed to detect version bumps)")
	}
}

func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "a.zip")
	writeTestZip(t, path, files)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
