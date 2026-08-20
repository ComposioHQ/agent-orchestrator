package cli

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

const remoteStatusJSON = `{
  "enabled": true,
  "host": "192.168.1.10",
  "tailscaleHost": "100.64.1.2",
  "port": 3011,
  "password": "sekrit99",
  "warning": "Traffic on this connection is not encrypted. Only use it on a network you trust.",
  "securePairing": {"enabled": true, "available": true, "active": true, "host": "pi.tail1234.ts.net", "port": 443, "reason": ""}
}`

// remoteCapture records the method/path of the request the CLI made.
type remoteCapture struct {
	method string
	path   string
}

func remoteServer(t *testing.T, status int, respBody string) (*httptest.Server, *remoteCapture) {
	t.Helper()
	capture := &remoteCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.method = r.Method
		capture.path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestRemoteStatusRedactsPassword(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := remoteServer(t, http.StatusOK, remoteStatusJSON)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(), "remote", "status")
	if err != nil {
		t.Fatalf("remote status: %v", err)
	}
	for _, want := range []string{"enabled", "https://pi.tail1234.ts.net", "3011", "secure pairing: active"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q; got:\n%s", want, out)
		}
	}
	if strings.Contains(out, "sekrit99") {
		t.Errorf("status output must never print the password; got:\n%s", out)
	}
}

func TestRemoteStatusJSONOmitsPassword(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := remoteServer(t, http.StatusOK, remoteStatusJSON)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(), "remote", "status", "--json")
	if err != nil {
		t.Fatalf("remote status --json: %v", err)
	}
	if strings.Contains(out, "sekrit99") || strings.Contains(out, `"password"`) {
		t.Errorf("--json output must omit the password entirely; got:\n%s", out)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if decoded["enabled"] != true {
		t.Errorf("enabled = %v, want true", decoded["enabled"])
	}
}

func TestRemoteStatusDisabled(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := remoteServer(t, http.StatusOK, `{"enabled": false, "warning": "w"}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(), "remote", "status")
	if err != nil {
		t.Fatalf("remote status: %v", err)
	}
	if !strings.Contains(out, "Remote access: disabled") {
		t.Errorf("output = %q, want disabled state", out)
	}
}

func TestRemoteCredentialsPrintsURLAndPassword(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := remoteServer(t, http.StatusOK, remoteStatusJSON)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(), "remote", "credentials")
	if err != nil {
		t.Fatalf("remote credentials: %v", err)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/mobile/status" {
		t.Errorf("request = %s %s, want GET /api/v1/mobile/status", capture.method, capture.path)
	}
	if !strings.Contains(out, "https://pi.tail1234.ts.net") || !strings.Contains(out, "sekrit99") {
		t.Errorf("credentials output must show URL and password; got:\n%s", out)
	}
}

func TestRemoteCredentialsWhenDisabled(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := remoteServer(t, http.StatusOK, `{"enabled": false}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "remote", "credentials")
	if err == nil {
		t.Fatal("expected an error when remote access is disabled")
	}
	if !strings.Contains(err.Error(), "not enabled") {
		t.Errorf("error = %q, want it to mention remote access is not enabled", err)
	}
	if ExitCode(err) != 1 {
		t.Errorf("ExitCode = %d, want 1 (runtime failure, not usage)", ExitCode(err))
	}
}

func TestRemoteRotatePrintsNewCredentialsOnce(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := remoteServer(t, http.StatusOK, remoteStatusJSON)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(), "remote", "rotate")
	if err != nil {
		t.Fatalf("remote rotate: %v", err)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/mobile/regenerate" {
		t.Errorf("request = %s %s, want POST /api/v1/mobile/regenerate", capture.method, capture.path)
	}
	if !strings.Contains(out, "sekrit99") {
		t.Errorf("rotate must print the new password once; got:\n%s", out)
	}
}

func TestRemoteEnableDisableHitExpectedRoutes(t *testing.T) {
	for name, tc := range map[string]struct {
		args    []string
		path    string
		wantOut string
	}{
		"enable":  {[]string{"remote", "enable"}, "/api/v1/mobile/enable", "Remote access enabled."},
		"disable": {[]string{"remote", "disable"}, "/api/v1/mobile/disable", "Remote access disabled."},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := setConfigEnv(t)
			srv, capture := remoteServer(t, http.StatusOK, remoteStatusJSON)
			writeRunFileFor(t, cfg, srv)

			out, _, err := executeCLI(t, aliveDeps(), tc.args...)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if capture.method != http.MethodPost || capture.path != tc.path {
				t.Errorf("request = %s %s, want POST %s", capture.method, capture.path, tc.path)
			}
			if !strings.Contains(out, tc.wantOut) {
				t.Errorf("output = %q, want %q", out, tc.wantOut)
			}
			if strings.Contains(out, "sekrit99") {
				t.Errorf("%s must not print the password; got:\n%s", name, out)
			}
		})
	}
}

func TestRemoteStatusMissingDaemon(t *testing.T) {
	setConfigEnv(t) // no run-file written
	_, _, err := executeCLI(t, aliveDeps(), "remote", "status")
	if err == nil {
		t.Fatal("expected an error when the daemon is not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error = %q, want the not-running message", err)
	}
	if ExitCode(err) != 1 {
		t.Errorf("ExitCode = %d, want 1", ExitCode(err))
	}
}

func TestRemoteStatusPreservesDaemonErrorEnvelope(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := remoteServer(t, http.StatusInternalServerError,
		`{"message": "bridge exploded", "code": "MOBILE_ENABLE", "requestId": "req-42"}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "remote", "status")
	if err == nil {
		t.Fatal("expected the daemon error to surface")
	}
	if got := err.Error(); !strings.Contains(got, "bridge exploded (MOBILE_ENABLE) [request req-42]") {
		t.Errorf("error = %q, want the full envelope", got)
	}
}

func TestRemoteRejectsExtraArgs(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, aliveDeps(), "remote", "status", "bogus")
	if err == nil {
		t.Fatal("expected a usage error for extra args")
	}
	if ExitCode(err) != 2 {
		t.Errorf("ExitCode = %d, want 2 for misuse", ExitCode(err))
	}
}

// --- Wire test: real router + real MobileController/BridgeService, driven by
// the actual CLI commands, so a renamed json tag on either side of the
// hand-mirrored DTO boundary fails loudly (same rationale as
// dto_drift_e2e_test.go). ---

type remoteFakeLAN struct {
	running bool
	hash    string
	port    int
}

func (f *remoteFakeLAN) Start(port int) (int, error) {
	f.running, f.port = true, port
	return port, nil
}
func (f *remoteFakeLAN) Stop(context.Context) error { f.running = false; return nil }
func (f *remoteFakeLAN) Running() bool              { return f.running }
func (f *remoteFakeLAN) BoundPort() int             { return f.port }
func (f *remoteFakeLAN) SetPasswordHash(h string)   { f.hash = h }
func (f *remoteFakeLAN) PasswordHash() string       { return f.hash }

func startRemoteWireDaemon(t *testing.T, bs *controllers.BridgeService) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Mobile: &controllers.MobileController{Bridge: bs},
	}, httpd.ControlDeps{})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	rfPath := filepath.Join(t.TempDir(), "running.json")
	t.Setenv("AO_RUN_FILE", rfPath)
	t.Setenv("AO_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	t.Setenv("AO_PORT", "3001")
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	if err := runfile.Write(rfPath, runfile.Info{PID: os.Getpid(), Port: port, StartedAt: time.Now()}); err != nil {
		t.Fatalf("write run-file: %v", err)
	}
}

func runRemote(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	root := NewRootCommand(Deps{
		Out:          &out,
		Err:          &out,
		HTTPClient:   &http.Client{},
		ProcessAlive: func(int) bool { return true },
		Sleep:        func(time.Duration) {},
	})
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestE2E_RemoteCommandsDTORoundTrip(t *testing.T) {
	lan := &remoteFakeLAN{}
	bs := &controllers.BridgeService{
		LAN:         lan,
		ConfigPath:  filepath.Join(t.TempDir(), "mobile", "config.json"),
		DefaultPort: mobilebridge.DefaultPort,
		ApplyServe:  func(int) error { return nil },
		ClearServe:  func() error { return nil },
		QueryTS: func() mobilebridge.TailscaleInfo {
			return mobilebridge.TailscaleInfo{Name: "pi.tail1234.ts.net", CertsEnabled: true}
		},
		ServeTarget: func() int { return lan.BoundPort() },
	}
	startRemoteWireDaemon(t, bs)

	// enable: the real controller generates and returns a password; the CLI
	// must decode it well enough to know secure pairing is not yet active.
	out, err := runRemote(t, "remote", "enable")
	if err != nil {
		t.Fatalf("enable: %v\noutput: %s", err, out)
	}
	if !strings.Contains(out, "Remote access enabled.") {
		t.Errorf("enable output = %q", out)
	}
	if !strings.Contains(out, "secure pairing) is not active") {
		t.Errorf("enable output should warn secure pairing is not active yet; got:\n%s", out)
	}

	// Turn secure pairing on at the service layer (the CLI deliberately has no
	// subcommand for it — `ao headless` owns that), then check status decodes
	// the nested securePairing fields.
	if _, err := bs.SetSecurePairing(true); err != nil {
		t.Fatalf("SetSecurePairing: %v", err)
	}
	out, err = runRemote(t, "remote", "status", "--json")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	var st struct {
		Enabled       bool `json:"enabled"`
		Port          int  `json:"port"`
		SecurePairing struct {
			Active bool   `json:"active"`
			Host   string `json:"host"`
		} `json:"securePairing"`
	}
	if err := json.Unmarshal([]byte(out), &st); err != nil {
		t.Fatalf("status output is not JSON: %v\n%s", err, out)
	}
	if !st.Enabled || st.Port != mobilebridge.DefaultPort || !st.SecurePairing.Active || st.SecurePairing.Host != "pi.tail1234.ts.net" {
		t.Errorf("decoded status = %+v; mirrored DTO drifted from MobileStatusResponse", st)
	}

	// credentials: password printed here (and only here) must be the one the
	// real bridge persisted.
	persisted, err := mobilebridge.Load(bs.ConfigPath)
	if err != nil {
		t.Fatalf("load persisted state: %v", err)
	}
	out, err = runRemote(t, "remote", "credentials")
	if err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if !strings.Contains(out, persisted.Password) || !strings.Contains(out, "https://pi.tail1234.ts.net") {
		t.Errorf("credentials output missing persisted password or pairing URL; got:\n%s", out)
	}

	// rotate: the printed password must match the newly persisted one, and
	// must differ from the pre-rotation one.
	out, err = runRemote(t, "remote", "rotate")
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	rotated, err := mobilebridge.Load(bs.ConfigPath)
	if err != nil {
		t.Fatalf("load persisted state: %v", err)
	}
	if rotated.Password == persisted.Password {
		t.Error("rotate did not change the persisted password")
	}
	if !strings.Contains(out, rotated.Password) {
		t.Errorf("rotate output missing the new persisted password; got:\n%s", out)
	}

	// disable: subsequent credentials must fail with the not-enabled error.
	if _, err := runRemote(t, "remote", "disable"); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := runRemote(t, "remote", "credentials"); err == nil {
		t.Error("credentials after disable: expected an error, got nil")
	}
}
