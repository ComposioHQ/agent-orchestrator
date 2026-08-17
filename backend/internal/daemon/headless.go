package daemon

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// runOptions parameterizes run. The zero value is the plain daemon boot used
// by the hidden `ao daemon` command and the desktop supervisor.
type runOptions struct {
	headless *HeadlessOptions
}

// HeadlessOptions configures `ao headless`: a foreground, systemd-friendly
// boot that additionally enables the authenticated remote/mobile listener and
// Tailscale Secure Pairing, failing closed when HTTPS cannot be established.
type HeadlessOptions struct {
	// RemotePort is the port the authenticated listener binds on 0.0.0.0
	// (mobilebridge.DefaultPort unless --remote-port overrides it).
	RemotePort int
	// Out receives the readiness banner (pairing URL and password-retrieval
	// instructions — never the password itself). Defaults to os.Stdout.
	Out io.Writer
	// checkTailscale is the fail-closed preflight; nil uses
	// mobilebridge.CheckTailscale. Injectable so tests never shell out.
	checkTailscale func(ctx context.Context) (mobilebridge.TailscaleInfo, error)
}

// RunHeadless starts the daemon like Run, then brings up remote access per
// opts before the server reports ready. See setupHeadlessRemote.
func RunHeadless(opts HeadlessOptions) error {
	if opts.RemotePort <= 0 || opts.RemotePort > 65535 {
		return fmt.Errorf("invalid remote port %d", opts.RemotePort)
	}
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	return run(runOptions{headless: &opts})
}

// setupHeadlessRemote enables the authenticated remote listener and Tailscale
// Secure Pairing for a headless boot, and verifies HTTPS is actually live
// before returning. It fails closed: any Tailscale, certificate, or
// `tailscale serve` problem is a non-zero exit with a clear error, never a
// silent fallback to officially-supported plaintext remote access.
//
// It replaces the best-effort restoreMobileOnBoot path for headless boots (it
// is a superset: same listener, same persisted state, same proxy re-apply),
// reusing the persisted connection password so already-paired clients keep
// working across restarts. Persisted enabled+securePairing state means a retry
// — or a plain `ao daemon` boot restore — converges to the same target after a
// failure here.
func setupHeadlessRemote(ctx context.Context, bs *controllers.BridgeService, opts HeadlessOptions, log *slog.Logger) error {
	check := opts.checkTailscale
	if check == nil {
		check = mobilebridge.CheckTailscale
	}
	info, err := check(ctx)
	if err != nil {
		return fmt.Errorf("headless remote access requires Tailscale: %w", err)
	}
	if !info.CertsEnabled {
		return fmt.Errorf("headless remote access requires Tailscale HTTPS certificates — enable HTTPS certificates in the tailnet admin console (DNS page)")
	}

	bs.DefaultPort = opts.RemotePort
	if _, err := bs.EnableReusingPassword(); err != nil {
		return fmt.Errorf("enable remote access listener: %w", err)
	}
	if st, _ := mobilebridge.Load(bs.ConfigPath); !st.SecurePairing {
		if _, err := bs.SetSecurePairing(true); err != nil {
			return fmt.Errorf("enable secure pairing: %w", err)
		}
	}

	sp := bs.Status().SecurePairing
	if !sp.Available || !sp.Active {
		reason := sp.Reason
		if reason == "" {
			reason = "unknown"
		}
		// Best-effort: do not leave the node-global :443 proxy pointed at a
		// bridge we are about to abandon.
		bs.ShutdownServe()
		return fmt.Errorf("secure pairing could not establish HTTPS (%s) — refusing remote access without TLS", reason)
	}

	log.Info("headless remote access ready", "host", sp.Host, "remotePort", bs.LAN.BoundPort())
	if _, err := fmt.Fprintf(opts.Out, "Remote access ready.\n  Pairing URL: https://%s\n  Retrieve the connection password with: ao remote credentials\n", sp.Host); err != nil {
		return fmt.Errorf("print readiness banner: %w", err)
	}
	return nil
}
