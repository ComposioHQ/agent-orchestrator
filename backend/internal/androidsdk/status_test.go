package androidsdk

import (
	"context"
	"net/http"
	"net/http/httptest"
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

func TestStartInstallTransitionsToInstalled(t *testing.T) {
	srv, cfg, _, _ := installTestServer(t)
	defer srv.Close()

	m := NewManager(cfg.ToolsDir)
	if err := m.StartInstall(context.Background(), cfg); err != nil {
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
	if err := m.StartInstall(context.Background(), cfg); err != nil {
		t.Fatalf("first StartInstall: %v", err)
	}
	if err := m.StartInstall(context.Background(), cfg); err == nil {
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
	if err := m.StartInstall(context.Background(), cfg); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}

	final := waitForState(t, m, StateFailed)
	if final.Error == "" {
		t.Error("Error is empty, want a failure message")
	}
}
