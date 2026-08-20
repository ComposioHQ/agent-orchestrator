package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

var headlessTS = mobilebridge.TailscaleInfo{Name: "pi.tail1234.ts.net", CertsEnabled: true}

func headlessPreflightOK(context.Context) (mobilebridge.TailscaleInfo, error) { return headlessTS, nil }

// newHeadlessBridge builds a BridgeService with the same injectable hooks the
// daemon wires in production, plus a dynamic ServeTarget that tracks the
// fake's bound port (the "serve proxy verified" happy path).
func newHeadlessBridge(t *testing.T, dir string, lan *fakeLAN) *controllers.BridgeService {
	t.Helper()
	return &controllers.BridgeService{
		LAN:         lan,
		ConfigPath:  mobilebridge.Path(dir),
		DefaultPort: mobilebridge.DefaultPort,
		ApplyServe:  func(int) error { return nil },
		ClearServe:  func() error { return nil },
		QueryTS:     func() mobilebridge.TailscaleInfo { return headlessTS },
		ServeTarget: func() int { return lan.BoundPort() },
	}
}

func TestHeadlessSetupHappyPath(t *testing.T) {
	dir := t.TempDir()
	lan := &fakeLAN{}
	bs := newHeadlessBridge(t, dir, lan)
	var out strings.Builder

	err := setupHeadlessRemote(context.Background(), bs, HeadlessOptions{
		RemotePort:     mobilebridge.DefaultPort,
		Out:            &out,
		checkTailscale: headlessPreflightOK,
	}, testLogger())
	if err != nil {
		t.Fatalf("setupHeadlessRemote: %v", err)
	}
	if !lan.started {
		t.Fatal("expected the authenticated listener started")
	}
	if lan.port != mobilebridge.DefaultPort {
		t.Errorf("bound port = %d, want %d", lan.port, mobilebridge.DefaultPort)
	}
	st, err := mobilebridge.Load(bs.ConfigPath)
	if err != nil {
		t.Fatalf("load state: %v", err)
	}
	if !st.Enabled || !st.SecurePairing || st.Password == "" {
		t.Errorf("persisted state = %+v, want enabled, secure pairing on, password set", st)
	}
	banner := out.String()
	if !strings.Contains(banner, "https://pi.tail1234.ts.net") {
		t.Errorf("banner missing pairing URL: %q", banner)
	}
	if !strings.Contains(banner, "ao remote credentials") {
		t.Errorf("banner missing password-retrieval instructions: %q", banner)
	}
	if strings.Contains(banner, st.Password) {
		t.Error("banner must never print the connection password")
	}
}

func TestHeadlessSetupHonorsRemotePort(t *testing.T) {
	lan := &fakeLAN{}
	bs := newHeadlessBridge(t, t.TempDir(), lan)
	err := setupHeadlessRemote(context.Background(), bs, HeadlessOptions{
		RemotePort:     4011,
		Out:            &strings.Builder{},
		checkTailscale: headlessPreflightOK,
	}, testLogger())
	if err != nil {
		t.Fatalf("setupHeadlessRemote: %v", err)
	}
	if lan.port != 4011 {
		t.Errorf("bound port = %d, want 4011", lan.port)
	}
}

// A simulated restart (fresh BridgeService over the same config dir) must
// reuse the persisted password, not rotate it.
func TestHeadlessSetupReusesPasswordAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	first := newHeadlessBridge(t, dir, &fakeLAN{})
	if err := setupHeadlessRemote(context.Background(), first, HeadlessOptions{
		RemotePort: mobilebridge.DefaultPort, Out: &strings.Builder{}, checkTailscale: headlessPreflightOK,
	}, testLogger()); err != nil {
		t.Fatalf("first boot: %v", err)
	}
	before, err := mobilebridge.Load(first.ConfigPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	second := newHeadlessBridge(t, dir, &fakeLAN{})
	var out strings.Builder
	if err := setupHeadlessRemote(context.Background(), second, HeadlessOptions{
		RemotePort: mobilebridge.DefaultPort, Out: &out, checkTailscale: headlessPreflightOK,
	}, testLogger()); err != nil {
		t.Fatalf("second boot: %v", err)
	}
	after, err := mobilebridge.Load(second.ConfigPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if after.Password != before.Password {
		t.Errorf("password rotated across restart (%q -> %q), want reuse", before.Password, after.Password)
	}
	if strings.Contains(out.String(), after.Password) {
		t.Error("banner must never print the connection password")
	}
}

// Fail-closed matrix: each Tailscale/serve failure mode must abort startup
// with a distinct, actionable error — never a plaintext listener.
func TestHeadlessSetupFailsClosed(t *testing.T) {
	cases := map[string]struct {
		mutate    func(bs *controllers.BridgeService, clearCalls *int)
		preflight func(ctx context.Context) (mobilebridge.TailscaleInfo, error)
		wantErr   string
		wantDown  bool // listener must not be left running
	}{
		"tailscale unreachable": {
			preflight: func(context.Context) (mobilebridge.TailscaleInfo, error) {
				return mobilebridge.TailscaleInfo{}, errors.New("tailscale status: exit status 1")
			},
			wantErr:  "requires Tailscale",
			wantDown: true,
		},
		"https certs disabled": {
			preflight: func(context.Context) (mobilebridge.TailscaleInfo, error) {
				return mobilebridge.TailscaleInfo{Name: "pi.tail1234.ts.net", CertsEnabled: false}, nil
			},
			wantErr:  "HTTPS certificates",
			wantDown: true,
		},
		"serve apply fails": {
			mutate: func(bs *controllers.BridgeService, _ *int) {
				bs.ApplyServe = func(int) error { return errors.New("serve: denied") }
			},
			preflight: headlessPreflightOK,
			wantErr:   "serve_failed",
		},
		"serve target mismatch": {
			mutate: func(bs *controllers.BridgeService, _ *int) {
				bs.ServeTarget = func() int { return 9999 }
			},
			preflight: headlessPreflightOK,
			wantErr:   "port_mismatch",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			lan := &fakeLAN{}
			bs := newHeadlessBridge(t, t.TempDir(), lan)
			clearCalls := 0
			bs.ClearServe = func() error { clearCalls++; return nil }
			if tc.mutate != nil {
				tc.mutate(bs, &clearCalls)
			}
			err := setupHeadlessRemote(context.Background(), bs, HeadlessOptions{
				RemotePort:     mobilebridge.DefaultPort,
				Out:            &strings.Builder{},
				checkTailscale: tc.preflight,
			}, testLogger())
			if err == nil {
				t.Fatal("expected fail-closed error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %q, want it to mention %q", err, tc.wantErr)
			}
			if tc.wantDown && lan.started {
				t.Error("listener started despite preflight failure")
			}
		})
	}
}

// A serve verification failure must not leave the node-global :443 proxy
// pointed at a bridge the daemon is abandoning.
func TestHeadlessSetupClearsProxyOnVerifyFailure(t *testing.T) {
	lan := &fakeLAN{}
	bs := newHeadlessBridge(t, t.TempDir(), lan)
	clearCalls := 0
	bs.ClearServe = func() error { clearCalls++; return nil }
	bs.ServeTarget = func() int { return 9999 } // force port_mismatch

	err := setupHeadlessRemote(context.Background(), bs, HeadlessOptions{
		RemotePort: mobilebridge.DefaultPort, Out: &strings.Builder{}, checkTailscale: headlessPreflightOK,
	}, testLogger())
	if err == nil {
		t.Fatal("expected fail-closed error, got nil")
	}
	if clearCalls == 0 {
		t.Error("expected ShutdownServe to clear the tailnet proxy on verification failure")
	}
}

func TestRunHeadlessValidatesRemotePort(t *testing.T) {
	for _, port := range []int{0, -1, 65536} {
		if err := RunHeadless(HeadlessOptions{RemotePort: port}); err == nil {
			t.Errorf("RemotePort %d: expected validation error, got nil", port)
		}
	}
}
