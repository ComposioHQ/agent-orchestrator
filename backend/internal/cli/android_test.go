package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func androidCLIServer(t *testing.T, status androidSDKStatusDTO, setupCalls *int, setupAccepted *bool) *httptest.Server {
	t.Helper()
	return androidCLIServerWithUseExisting(t, status, setupCalls, setupAccepted, nil, androidSDKStatusDTO{})
}

func androidCLIServerWithUseExisting(t *testing.T, status androidSDKStatusDTO, setupCalls *int, setupAccepted *bool, useExistingCalls *int, useExistingResult androidSDKStatusDTO) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/android-device/sdk/status":
			_ = json.NewEncoder(w).Encode(status)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/android-device/sdk/setup":
			*setupCalls++
			var body androidSDKSetupRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			*setupAccepted = body.AcceptLicenses
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(androidSDKStatusDTO{State: "downloading"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/android-device/sdk/use-existing":
			if useExistingCalls != nil {
				*useExistingCalls++
			}
			_ = json.NewEncoder(w).Encode(useExistingResult)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestAndroidSDKStatusCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	status := androidSDKStatusDTO{
		State: "downloading",
		Components: []androidSDKComponentProgress{
			{Component: "platform-tools", BytesDone: 500, BytesTotal: 1000},
		},
	}
	var calls int
	var accepted bool
	srv := androidCLIServer(t, status, &calls, &accepted)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "sdk", "status")
	if err != nil {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if !strings.Contains(out, "state: downloading") || !strings.Contains(out, "platform-tools: 500/1000 bytes") {
		t.Fatalf("status output = %q", out)
	}
}

func TestAndroidSDKSetupRequiresAcceptLicensesFlag(t *testing.T) {
	cfg := setConfigEnv(t)
	var calls int
	var accepted bool
	srv := androidCLIServer(t, androidSDKStatusDTO{}, &calls, &accepted)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	_, _, err := executeCLI(t, deps, "android", "sdk", "setup")
	if err == nil {
		t.Fatal("setup without --accept-licenses: want an error, got nil")
	}
	if calls != 0 {
		t.Errorf("server was contacted %d times without --accept-licenses, want 0", calls)
	}
}

func TestAndroidSDKStatusShowsDetected(t *testing.T) {
	cfg := setConfigEnv(t)
	status := androidSDKStatusDTO{
		State:    "not_installed",
		Detected: &androidSDKDetectedInfo{Root: "/opt/android-sdk", APILevel: 34, Tag: "google_apis", ABI: "x86_64"},
	}
	var calls int
	var accepted bool
	srv := androidCLIServer(t, status, &calls, &accepted)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "sdk", "status")
	if err != nil {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if !strings.Contains(out, "detected:") || !strings.Contains(out, "/opt/android-sdk") || !strings.Contains(out, "google_apis") {
		t.Fatalf("status output = %q, want a detected line", out)
	}
}

func TestAndroidSDKStatusShowsSource(t *testing.T) {
	cfg := setConfigEnv(t)
	status := androidSDKStatusDTO{State: "installed", Source: "external"}
	var calls int
	var accepted bool
	srv := androidCLIServer(t, status, &calls, &accepted)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "sdk", "status")
	if err != nil {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if !strings.Contains(out, "source: external") {
		t.Fatalf("status output = %q, want a source line", out)
	}
}

func TestAndroidSDKUseExistingCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	var setupCalls, useExistingCalls int
	var accepted bool
	result := androidSDKStatusDTO{State: "installed", Source: "external"}
	srv := androidCLIServerWithUseExisting(t, androidSDKStatusDTO{}, &setupCalls, &accepted, &useExistingCalls, result)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "sdk", "use-existing")
	if err != nil {
		t.Fatalf("use-existing err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if useExistingCalls != 1 {
		t.Errorf("server was contacted %d times, want 1", useExistingCalls)
	}
	if !strings.Contains(out, "state: installed") || !strings.Contains(out, "source: external") {
		t.Fatalf("use-existing output = %q", out)
	}
}

func TestAndroidSDKSetupWithAcceptLicenses(t *testing.T) {
	cfg := setConfigEnv(t)
	var calls int
	var accepted bool
	srv := androidCLIServer(t, androidSDKStatusDTO{}, &calls, &accepted)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "sdk", "setup", "--accept-licenses")
	if err != nil {
		t.Fatalf("setup err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if calls != 1 || !accepted {
		t.Errorf("calls=%d accepted=%v, want 1 call with true", calls, accepted)
	}
	if !strings.Contains(out, "state: downloading") {
		t.Fatalf("setup output = %q", out)
	}
}
