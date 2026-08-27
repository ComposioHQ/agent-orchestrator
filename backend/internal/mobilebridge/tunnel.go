package mobilebridge

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The hostname of a quick tunnel is only ever available by scraping
// cloudflared's stderr — there is no API for it — so these patterns are a
// contract with a specific cloudflared version. Pin the binary, and let
// tunnel_test.go's verbatim fixtures fail loudly if an upgrade changes the
// format, rather than leaving a tunnel that silently never becomes ready.
var (
	quickTunnelURLRe = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)
	registeredRe     = regexp.MustCompile(`Registered tunnel connection`)
	locationRe       = regexp.MustCompile(`location=([a-z0-9]+)`)
	protocolRe       = regexp.MustCompile(`protocol=([a-z0-9]+)`)
)

// TunnelLog accumulates the signals worth extracting from cloudflared's output.
type TunnelLog struct {
	// URL is the public hostname, once printed.
	URL string
	// Connections counts registered edge connections. Quick tunnels register
	// one; named tunnels register several across colos.
	Connections int
	// Location and Protocol are the edge the connector attached to. Diagnostic
	// only — latency varies several-fold with this value.
	Location string
	Protocol string
}

// Feed consumes one line of cloudflared output.
func (t *TunnelLog) Feed(line string) {
	if t.URL == "" {
		if m := quickTunnelURLRe.FindString(line); m != "" {
			t.URL = m
		}
	}
	if registeredRe.MatchString(line) {
		t.Connections++
		if m := locationRe.FindStringSubmatch(line); m != nil {
			t.Location = m[1]
		}
		if m := protocolRe.FindStringSubmatch(line); m != nil {
			t.Protocol = m[1]
		}
	}
}

// Ready reports whether the tunnel can actually carry traffic.
//
// Both conditions are required. cloudflared prints the hostname several
// seconds before it registers a connection, and an endpoint advertised during
// that window answers HTTP 530.
func (t *TunnelLog) Ready() bool {
	return t.URL != "" && t.Connections > 0
}

// splitLines splits process output into lines, dropping a trailing empty one.
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	out := strings.Split(s, "\n")
	if len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}

// MinCloudflaredVersion is the oldest system-installed cloudflared we will
// reuse. Older builds differ in flags and log format, and the hostname is only
// available by scraping that format. Below this we install our own managed copy
// alongside rather than touching the user's package-managed one.
var MinCloudflaredVersion = CloudflaredVersion{2025, 8, 0}

// CloudflaredVersion is cloudflared's CalVer, as {year, month, patch}.
type CloudflaredVersion [3]int

var cloudflaredVersionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// ParseCloudflaredVersion reads the version out of `cloudflared --version`.
func ParseCloudflaredVersion(out string) (CloudflaredVersion, bool) {
	m := cloudflaredVersionRe.FindStringSubmatch(out)
	if m == nil {
		return CloudflaredVersion{}, false
	}
	var v CloudflaredVersion
	for i := range v {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return CloudflaredVersion{}, false
		}
		v[i] = n
	}
	return v, true
}

// AtLeast reports whether v is floor or newer. Components compare numerically:
// a lexical comparison would rank 2026.10.0 below 2026.9.0.
func (v CloudflaredVersion) AtLeast(floor CloudflaredVersion) bool {
	for i := range v {
		if v[i] != floor[i] {
			return v[i] > floor[i]
		}
	}
	return true
}

// CloudflaredSource records where a resolved binary came from, for logging and
// for the desktop to explain what it is about to do.
type CloudflaredSource string

const (
	// CloudflaredFromEnv is an explicit AO_CLOUDFLARED_PATH override.
	CloudflaredFromEnv CloudflaredSource = "env"
	// CloudflaredManaged is AO's own pinned copy under ~/.ao/bin.
	CloudflaredManaged CloudflaredSource = "managed"
	// CloudflaredFromSystem is a copy the user already installed.
	CloudflaredFromSystem CloudflaredSource = "system"
	// CloudflaredAbsent means nothing usable was found.
	CloudflaredAbsent CloudflaredSource = "absent"
)

// CloudflaredLookup is the injected environment ResolveCloudflared inspects.
// Every filesystem and PATH touch goes through these, so resolution is
// testable without depending on what the machine happens to have installed.
type CloudflaredLookup struct {
	// EnvPath is $AO_CLOUDFLARED_PATH.
	EnvPath string
	// ManagedPath is where AO keeps its own pinned copy (~/.ao/bin/cloudflared).
	ManagedPath string
	LookPath    func(file string) (string, error)
	Exists      func(path string) bool
	Version     func(path string) (CloudflaredVersion, bool)
}

// CloudflaredResolution is which binary to run, or that one must be installed.
type CloudflaredResolution struct {
	Path         string
	Source       CloudflaredSource
	NeedsInstall bool
	// SystemPath is a system copy that was found but rejected as too old or
	// unidentifiable. Recorded so the desktop can say why it is installing its
	// own rather than appearing to ignore what the user already has.
	SystemPath string
}

// ResolveCloudflared picks the cloudflared to run.
//
// Order: explicit override, then AO's managed copy, then a system install that
// is recent enough, then install our own.
//
// Two rules matter. A user's package-managed binary is never modified or
// upgraded — that is their package manager's job — so an outdated system copy
// means we install beside it rather than over it. And the version gate applies
// only to system copies: the managed copy is one we pinned, and the override is
// an operator saying "use exactly this".
func ResolveCloudflared(l CloudflaredLookup) CloudflaredResolution {
	if l.EnvPath != "" {
		return CloudflaredResolution{Path: l.EnvPath, Source: CloudflaredFromEnv}
	}
	if l.ManagedPath != "" && l.Exists != nil && l.Exists(l.ManagedPath) {
		return CloudflaredResolution{Path: l.ManagedPath, Source: CloudflaredManaged}
	}
	if l.LookPath != nil {
		if sys, err := l.LookPath("cloudflared"); err == nil && sys != "" {
			if v, ok := l.Version(sys); ok && v.AtLeast(MinCloudflaredVersion) {
				return CloudflaredResolution{Path: sys, Source: CloudflaredFromSystem}
			}
			return CloudflaredResolution{Source: CloudflaredAbsent, NeedsInstall: true, SystemPath: sys}
		}
	}
	return CloudflaredResolution{Source: CloudflaredAbsent, NeedsInstall: true}
}

// ManagedCloudflaredPath is where AO keeps its own pinned copy.
func ManagedCloudflaredPath(dataDir string) string {
	name := "cloudflared"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dataDir, "bin", name)
}

// LocalCloudflaredLookup builds the production lookup: the real PATH, the real
// filesystem, and `cloudflared --version` for the version gate.
func LocalCloudflaredLookup(dataDir string) CloudflaredLookup {
	return CloudflaredLookup{
		EnvPath:     os.Getenv("AO_CLOUDFLARED_PATH"),
		ManagedPath: ManagedCloudflaredPath(dataDir),
		LookPath:    exec.LookPath,
		Exists: func(p string) bool {
			fi, err := os.Stat(p)
			return err == nil && !fi.IsDir()
		},
		Version: func(p string) (CloudflaredVersion, bool) {
			ctx, cancel := context.WithTimeout(context.Background(), cloudflaredVersionTimeout)
			defer cancel()
			out, err := exec.CommandContext(ctx, p, "--version").CombinedOutput()
			if err != nil {
				return CloudflaredVersion{}, false
			}
			return ParseCloudflaredVersion(string(out))
		},
	}
}

// cloudflaredVersionTimeout bounds the `--version` probe. A hung binary must
// not stall daemon startup.
const cloudflaredVersionTimeout = 5 * time.Second

// TunnelPIDPath is where the managed connector's pid is recorded
// (~/.ao/mobile/tunnel.pid).
func TunnelPIDPath(dataDir string) string {
	return filepath.Join(dataDir, "mobile", "tunnel.pid")
}

// WriteTunnelPID records the pid of the connector we just spawned, so a daemon
// that dies without stopping it can clean up on its next start.
func WriteTunnelPID(path string, pid int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir mobile dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(pid)+"\n"), 0o600); err != nil {
		return fmt.Errorf("write tunnel pid: %w", err)
	}
	return nil
}

// ReadTunnelPID returns the recorded pid, if there is one.
func ReadTunnelPID(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// ReapStaleTunnel kills a connector left behind by a previous daemon, then
// clears the record.
//
// Without this, a daemon crash leaves a public tunnel to the machine running
// with nobody watching it.
//
// isOurs is required and must actually confirm the process: pids are reused, so
// killing a recorded pid on trust alone would eventually kill something
// unrelated. When it cannot confirm, we clear the file and kill nothing —
// leaking a tunnel until reboot is a far smaller harm than killing an arbitrary
// process.
func ReapStaleTunnel(path string, isOurs func(pid int) bool, kill func(pid int) error) error {
	pid, ok := ReadTunnelPID(path)
	if !ok {
		return nil
	}
	defer func() { _ = os.Remove(path) }()

	if isOurs == nil || !isOurs(pid) {
		return nil
	}
	if err := kill(pid); err != nil {
		return fmt.Errorf("kill stale tunnel %d: %w", pid, err)
	}
	return nil
}
