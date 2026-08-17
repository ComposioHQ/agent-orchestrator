package mobilebridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// tailscaleTimeout bounds every CLI call. The Connect Mobile status endpoint is
// polled by the modal, so a wedged tailscaled must never stall it.
const tailscaleTimeout = 3 * time.Second

// TailscaleRunner runs the tailscale CLI and returns its stdout. Injected so
// tests never invoke the real binary.
type TailscaleRunner func(ctx context.Context, args ...string) ([]byte, error)

// execTailscale is the production TailscaleRunner.
func execTailscale(ctx context.Context, args ...string) ([]byte, error) {
	return aoprocess.CommandContext(ctx, "tailscale", args...).Output()
}

// TailscaleInfo is what the local daemon can tell us about this node.
type TailscaleInfo struct {
	// Name is the MagicDNS name with no trailing dot, or "" when unavailable.
	Name string
	// CertsEnabled reports whether the tailnet can issue HTTPS certificates,
	// which `tailscale serve --https` requires.
	CertsEnabled bool
}

// QueryTailscale reports this node's MagicDNS name and certificate
// availability. Every failure — missing binary, non-zero exit, malformed
// output — yields the zero value; callers treat an empty Name as
// "secure pairing unavailable" rather than as an error to surface.
func QueryTailscale(ctx context.Context) TailscaleInfo {
	return queryTailscale(ctx, execTailscale)
}

func queryTailscale(ctx context.Context, run TailscaleRunner) TailscaleInfo {
	info, err := checkTailscale(ctx, run)
	if err != nil {
		return TailscaleInfo{}
	}
	return info
}

// CheckTailscale is the error-returning variant of QueryTailscale for callers
// that must fail closed with a precise reason (ao headless): a missing or
// failing tailscale CLI, malformed output, and a missing MagicDNS name each
// surface as a distinct error instead of collapsing into the zero value.
func CheckTailscale(ctx context.Context) (TailscaleInfo, error) {
	return checkTailscale(ctx, execTailscale)
}

func checkTailscale(ctx context.Context, run TailscaleRunner) (TailscaleInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, tailscaleTimeout)
	defer cancel()
	out, err := run(ctx, "status", "--json")
	if err != nil {
		return TailscaleInfo{}, fmt.Errorf("tailscale status: %w", err)
	}
	var parsed struct {
		Self        *struct{ DNSName string } `json:"Self"`
		CertDomains []string                  `json:"CertDomains"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return TailscaleInfo{}, fmt.Errorf("parse tailscale status: %w", err)
	}
	if parsed.Self == nil {
		return TailscaleInfo{}, fmt.Errorf("tailscale status reports no self node — is tailscaled up and logged in?")
	}
	name := strings.TrimSuffix(parsed.Self.DNSName, ".")
	if name == "" {
		return TailscaleInfo{}, fmt.Errorf("tailscale: no MagicDNS name for this node — enable MagicDNS in the tailnet admin console")
	}
	return TailscaleInfo{Name: name, CertsEnabled: len(parsed.CertDomains) > 0}, nil
}
