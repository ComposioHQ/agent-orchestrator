package androidsdk

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func waitForState(t *testing.T, m *Manager, want State) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last Status
	for time.Now().Before(deadline) {
		last = m.Status()
		if last.State == want {
			return last
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Status().State never reached %q, stuck at %q (error=%q)", want, last.State, last.Error)
	return Status{}
}

func TestNewManagerNotInstalledWhenNoManifest(t *testing.T) {
	m := NewManager(t.TempDir())
	if got := m.Status().State; got != StateNotInstalled {
		t.Errorf("State = %q, want %q", got, StateNotInstalled)
	}
}

func TestNewManagerInstalledWhenManifestPresent(t *testing.T) {
	toolsDir := t.TempDir()
	if err := writeInstalledManifest(toolsDir, installedManifest{PlatformToolsSHA1: "x"}); err != nil {
		t.Fatal(err)
	}
	m := NewManager(toolsDir)
	if got := m.Status().State; got != StateInstalled {
		t.Errorf("State = %q, want %q", got, StateInstalled)
	}
}

func TestNewManagerInstalledFromExternalMarker(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 34, "google_apis", "x86_64")
	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}
	if err := writeExternalSDKRecord(toolsDir, d); err != nil {
		t.Fatal(err)
	}

	m := NewManager(toolsDir)
	if got := m.Status().State; got != StateInstalled {
		t.Errorf("State = %q, want %q (external adoption must survive a daemon restart)", got, StateInstalled)
	}
}

func TestUseExternalTransitionsToInstalled(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 34, "google_apis", "x86_64")
	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}

	m := NewManager(toolsDir)
	if err := m.UseExternal(d); err != nil {
		t.Fatalf("UseExternal: %v", err)
	}
	if got := m.Status().State; got != StateInstalled {
		t.Errorf("State = %q, want %q", got, StateInstalled)
	}

	sdk, ok := Installed(toolsDir)
	if !ok || sdk.Source != SourceExternal || sdk.Root != extRoot {
		t.Errorf("Installed = %+v (ok=%v), want Source=%q Root=%q", sdk, ok, SourceExternal, extRoot)
	}
}

func TestUseExternalRejectsWhileInstallRunning(t *testing.T) {
	srv, cfg, _, _ := installTestServer(t)
	defer srv.Close()

	m := NewManager(cfg.ToolsDir)
	if err := m.StartInstall(cfg); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}

	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 34, "google_apis", "x86_64")
	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}
	if err := m.UseExternal(d); err == nil {
		t.Error("UseExternal while an install is running: want an error, got nil")
	}

	waitForState(t, m, StateInstalled)
}

func TestStatusSelfHealsWhenExternalSDKVanishes(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKBinaries(t, extRoot)
	writeFakeSystemImage(t, extRoot, 34, "google_apis", "x86_64")
	d := DetectedSDK{Root: extRoot, SystemImage: DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}

	m := NewManager(toolsDir)
	if err := m.UseExternal(d); err != nil {
		t.Fatalf("UseExternal: %v", err)
	}
	if got := m.Status().State; got != StateInstalled {
		t.Fatalf("State = %q, want %q before removing the external SDK", got, StateInstalled)
	}

	if err := os.RemoveAll(extRoot); err != nil {
		t.Fatal(err)
	}

	if got := m.Status().State; got != StateNotInstalled {
		t.Errorf("State = %q, want %q after the external SDK vanished from disk", got, StateNotInstalled)
	}
}

func TestStartInstallTransitionsToInstalled(t *testing.T) {
	srv, cfg, _, _ := installTestServer(t)
	defer srv.Close()

	m := NewManager(cfg.ToolsDir)
	if err := m.StartInstall(cfg); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}

	final := waitForState(t, m, StateInstalled)
	if final.Error != "" {
		t.Errorf("Error = %q, want empty on success", final.Error)
	}
}

func TestStartInstallRejectsConcurrentRun(t *testing.T) {
	srv, cfg, _, _ := installTestServer(t)
	defer srv.Close()

	m := NewManager(cfg.ToolsDir)
	if err := m.StartInstall(cfg); err != nil {
		t.Fatalf("first StartInstall: %v", err)
	}
	if err := m.StartInstall(cfg); err == nil {
		t.Error("second concurrent StartInstall: want an error, got nil")
	}
	waitForState(t, m, StateInstalled)
}

func TestStartInstallTransitionsToFailedOnError(t *testing.T) {
	// A server that 500s on every request makes Install fail deterministically.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	toolsDir := t.TempDir()
	cfg := InstallConfig{
		Client:                srv.Client(),
		RepositoryManifestURL: srv.URL + "/repository2-3.xml",
		SysImgManifestURL:     srv.URL + "/sys-img2-3.xml",
		DownloadBaseURL:       srv.URL + "/",
		SysImgDownloadBaseURL: srv.URL + "/",
		ToolsDir:              toolsDir,
		Platform:              Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"},
		APILevel:              34,
		Tag:                   "google_apis",
		AcceptLicenses:        true,
	}

	m := NewManager(toolsDir)
	if err := m.StartInstall(cfg); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}

	final := waitForState(t, m, StateFailed)
	if final.Error == "" {
		t.Error("Error is empty, want a failure message")
	}
}
