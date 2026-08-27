package mobilebridge

import (
	"os"
	"path/filepath"
	"testing"
)

// Verbatim cloudflared 2026.7.2 stderr. The hostname is only ever available by
// scraping this output, so these fixtures are the contract: if a cloudflared
// upgrade changes the format, this test fails instead of the tunnel silently
// never becoming ready.
const cloudflaredStartup = `2026-08-26T20:07:33Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee.
2026-08-26T20:07:33Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-26T20:07:38Z INF +--------------------------------------------------------------------------------------------+
2026-08-26T20:07:38Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-26T20:07:38Z INF |  https://ferrari-moderate-internet-lid.trycloudflare.com                                   |
2026-08-26T20:07:38Z INF +--------------------------------------------------------------------------------------------+
2026-08-26T20:07:38Z INF Generated Connector ID: dc21c5eb-e1a4-4636-8fbb-0d688fa3de8d
2026-08-26T20:07:40Z INF Registered tunnel connection connIndex=0 connection=7dc4ace9-1ce7-42f9-98a2-ecc14c6987d7 event=0 ip=2606:4700:a8::6 location=bom11 protocol=quic`

func feedLines(t *testing.T, text string) *TunnelLog {
	t.Helper()
	log := &TunnelLog{}
	for _, line := range splitLines(text) {
		log.Feed(line)
	}
	return log
}

func TestTunnelLogReadsHostnameAndReadiness(t *testing.T) {
	got := feedLines(t, cloudflaredStartup)

	if got.URL != "https://ferrari-moderate-internet-lid.trycloudflare.com" {
		t.Errorf("URL = %q", got.URL)
	}
	if !got.Ready() {
		t.Error("not ready after a registered connection")
	}
	if got.Location != "bom11" {
		t.Errorf("Location = %q want bom11", got.Location)
	}
	if got.Protocol != "quic" {
		t.Errorf("Protocol = %q want quic", got.Protocol)
	}
}

// Measured: cloudflared prints the hostname ~5s before it registers a
// connection. Advertising the endpoint in that window hands the phone an
// address that answers HTTP 530, so a URL alone must not count as ready.
func TestTunnelLogNotReadyOnHostnameAlone(t *testing.T) {
	partial := `2026-08-26T20:07:38Z INF |  https://ferrari-moderate-internet-lid.trycloudflare.com  |
2026-08-26T20:07:38Z INF Generated Connector ID: dc21c5eb-e1a4-4636-8fbb-0d688fa3de8d`

	got := feedLines(t, partial)

	if got.URL == "" {
		t.Fatal("hostname not captured")
	}
	if got.Ready() {
		t.Error("reported ready before any connection was registered")
	}
}

func TestTunnelLogNotReadyWithoutHostname(t *testing.T) {
	// A registered connection with no hostname parsed means the format changed.
	// Readiness must require both, so the failure is visible rather than a
	// tunnel that is "ready" at the empty address.
	got := feedLines(t, `2026-08-26T20:07:40Z INF Registered tunnel connection connIndex=0 location=bom11 protocol=quic`)

	if got.Ready() {
		t.Error("reported ready with no hostname")
	}
}

func TestParseCloudflaredVersion(t *testing.T) {
	for _, tc := range []struct {
		name, out string
		want      CloudflaredVersion
		ok        bool
	}{
		{"real --version output", "cloudflared version 2026.7.2 (built 2026-07-15T11:01:07Z)", CloudflaredVersion{2026, 7, 2}, true},
		{"trailing newline", "cloudflared version 2025.11.0 (built x)\n", CloudflaredVersion{2025, 11, 0}, true},
		{"no version present", "some other binary", CloudflaredVersion{}, false},
		{"empty", "", CloudflaredVersion{}, false},
	} {
		got, ok := ParseCloudflaredVersion(tc.out)
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s: got (%v, %v) want (%v, %v)", tc.name, got, ok, tc.want, tc.ok)
		}
	}
}

func TestCloudflaredVersionOrdersNumerically(t *testing.T) {
	// cloudflared is CalVer, so the components must compare as numbers. A
	// lexical comparison would rank 2026.10.0 below 2026.9.0 and reject a
	// perfectly good binary every October.
	for _, tc := range []struct {
		name   string
		v, min CloudflaredVersion
		want   bool
	}{
		{"equal", CloudflaredVersion{2026, 7, 2}, CloudflaredVersion{2026, 7, 2}, true},
		{"newer patch", CloudflaredVersion{2026, 7, 3}, CloudflaredVersion{2026, 7, 2}, true},
		{"older patch", CloudflaredVersion{2026, 7, 1}, CloudflaredVersion{2026, 7, 2}, false},
		{"month 10 beats month 9", CloudflaredVersion{2026, 10, 0}, CloudflaredVersion{2026, 9, 0}, true},
		{"month 9 below month 10", CloudflaredVersion{2026, 9, 0}, CloudflaredVersion{2026, 10, 0}, false},
		{"newer year, older month", CloudflaredVersion{2026, 1, 0}, CloudflaredVersion{2025, 12, 9}, true},
		{"older year, newer month", CloudflaredVersion{2025, 12, 9}, CloudflaredVersion{2026, 1, 0}, false},
	} {
		if got := tc.v.AtLeast(tc.min); got != tc.want {
			t.Errorf("%s: %v.AtLeast(%v) = %v want %v", tc.name, tc.v, tc.min, got, tc.want)
		}
	}
}

// lookupFor builds a CloudflaredLookup whose filesystem and PATH are entirely
// injected, so resolution never depends on what the test machine has installed.
func lookupFor(env, managed, system string, versions map[string]CloudflaredVersion) CloudflaredLookup {
	present := map[string]bool{}
	for _, p := range []string{env, managed, system} {
		if p != "" {
			present[p] = true
		}
	}
	return CloudflaredLookup{
		EnvPath:     env,
		ManagedPath: managed,
		LookPath: func(string) (string, error) {
			if system == "" {
				return "", os.ErrNotExist
			}
			return system, nil
		},
		Exists: func(p string) bool { return present[p] },
		Version: func(p string) (CloudflaredVersion, bool) {
			v, ok := versions[p]
			return v, ok
		},
	}
}

func TestResolveCloudflaredPrefersExplicitOverride(t *testing.T) {
	// AO_CLOUDFLARED_PATH is the escape hatch for CI, enterprise images, and
	// air-gapped installs. It wins outright, and is not version-gated: the
	// operator asked for that binary specifically.
	got := ResolveCloudflared(lookupFor("/opt/cf", "/home/u/.ao/bin/cloudflared", "/usr/local/bin/cloudflared",
		map[string]CloudflaredVersion{"/opt/cf": {2019, 1, 0}}))

	if got.Path != "/opt/cf" || got.Source != CloudflaredFromEnv {
		t.Fatalf("got %+v, want /opt/cf from env", got)
	}
	if got.NeedsInstall {
		t.Error("explicit override should never ask for an install")
	}
}

func TestResolveCloudflaredPrefersOurManagedCopyOverSystem(t *testing.T) {
	got := ResolveCloudflared(lookupFor("", "/home/u/.ao/bin/cloudflared", "/usr/local/bin/cloudflared",
		map[string]CloudflaredVersion{
			"/home/u/.ao/bin/cloudflared": {2026, 7, 2},
			"/usr/local/bin/cloudflared":  {2026, 7, 2},
		}))

	if got.Path != "/home/u/.ao/bin/cloudflared" || got.Source != CloudflaredManaged {
		t.Fatalf("got %+v, want the managed copy", got)
	}
}

func TestResolveCloudflaredReusesARecentSystemInstall(t *testing.T) {
	// The whole point: if the user already has cloudflared from brew or apt, use
	// it. Do not download a second copy, and never upgrade theirs.
	got := ResolveCloudflared(lookupFor("", "", "/opt/homebrew/bin/cloudflared",
		map[string]CloudflaredVersion{"/opt/homebrew/bin/cloudflared": {2026, 7, 2}}))

	if got.Path != "/opt/homebrew/bin/cloudflared" || got.Source != CloudflaredFromSystem {
		t.Fatalf("got %+v, want the system install reused", got)
	}
	if got.NeedsInstall {
		t.Error("a recent system install must not trigger a download")
	}
}

func TestResolveCloudflaredInstallsAlongsideAnOldSystemCopy(t *testing.T) {
	// Too old to parse reliably, but it is the user's package-managed binary.
	// We install our own beside it rather than touching theirs.
	got := ResolveCloudflared(lookupFor("", "", "/usr/bin/cloudflared",
		map[string]CloudflaredVersion{"/usr/bin/cloudflared": {2021, 3, 1}}))

	if !got.NeedsInstall {
		t.Fatal("an outdated system copy should trigger a managed install")
	}
	if got.Path == "/usr/bin/cloudflared" {
		t.Error("must not run the outdated system binary")
	}
}

func TestResolveCloudflaredInstallsWhenNothingIsPresent(t *testing.T) {
	got := ResolveCloudflared(lookupFor("", "", "", nil))

	if !got.NeedsInstall {
		t.Fatal("nothing installed should trigger an install")
	}
	if got.Source != CloudflaredAbsent {
		t.Errorf("Source = %q want absent", got.Source)
	}
}

func TestResolveCloudflaredIgnoresASystemBinaryOfUnknownVersion(t *testing.T) {
	// `cloudflared --version` that we cannot parse means we cannot know whether
	// the log format matches what the scraper expects.
	got := ResolveCloudflared(lookupFor("", "", "/usr/bin/cloudflared", nil))

	if !got.NeedsInstall {
		t.Fatal("unparseable version should trigger a managed install")
	}
}

func TestTunnelPIDRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mobile", "tunnel.pid")

	if err := WriteTunnelPID(path, 4242); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, ok := ReadTunnelPID(path)
	if !ok || got != 4242 {
		t.Fatalf("got (%d, %v) want (4242, true)", got, ok)
	}
}

func TestReadTunnelPIDAbsentWhenNeverWritten(t *testing.T) {
	if _, ok := ReadTunnelPID(filepath.Join(t.TempDir(), "tunnel.pid")); ok {
		t.Fatal("reported a pid with no file")
	}
}

// The reason this file exists: a daemon crash must not leave a public tunnel to
// the machine running unattended. On the next start we kill what we spawned.
func TestReapStaleTunnelKillsAnOrphanedConnector(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tunnel.pid")
	if err := WriteTunnelPID(path, 4242); err != nil {
		t.Fatalf("write: %v", err)
	}

	killed := 0
	err := ReapStaleTunnel(path,
		func(pid int) bool { return pid == 4242 }, // still running, and ours
		func(pid int) error { killed = pid; return nil },
	)
	if err != nil {
		t.Fatalf("reap: %v", err)
	}
	if killed != 4242 {
		t.Fatalf("killed %d, want 4242", killed)
	}
	if _, ok := ReadTunnelPID(path); ok {
		t.Error("pid file survived the reap")
	}
}

// PIDs are reused. Killing a recorded pid without confirming it is still our
// cloudflared would eventually kill an unrelated process — potentially one the
// user cares about far more than a tunnel.
func TestReapStaleTunnelNeverKillsAnUnconfirmedProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tunnel.pid")
	if err := WriteTunnelPID(path, 4242); err != nil {
		t.Fatalf("write: %v", err)
	}

	killed := false
	err := ReapStaleTunnel(path,
		func(int) bool { return false }, // pid reused by something else
		func(int) error { killed = true; return nil },
	)
	if err != nil {
		t.Fatalf("reap: %v", err)
	}
	if killed {
		t.Fatal("killed a process that was not confirmed to be ours")
	}
	if _, ok := ReadTunnelPID(path); ok {
		t.Error("stale pid file should still be cleared")
	}
}

func TestReapStaleTunnelIsANoOpWithoutAPIDFile(t *testing.T) {
	killed := false
	err := ReapStaleTunnel(filepath.Join(t.TempDir(), "tunnel.pid"),
		func(int) bool { return true },
		func(int) error { killed = true; return nil },
	)
	if err != nil {
		t.Fatalf("reap: %v", err)
	}
	if killed {
		t.Fatal("killed something with no pid file present")
	}
}
