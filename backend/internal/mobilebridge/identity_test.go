package mobilebridge

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hw(t *testing.T, s string) net.HardwareAddr {
	t.Helper()
	a, err := net.ParseMAC(s)
	if err != nil {
		t.Fatalf("bad MAC %q: %v", s, err)
	}
	return a
}

func TestMachineFingerprintIgnoresInterfaceOrder(t *testing.T) {
	// net.Interfaces() makes no ordering guarantee across reboots. If the
	// fingerprint depended on order, a reboot would look like a different
	// machine and every paired phone would be told the host identity changed.
	a := []net.Interface{
		{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:01")},
		{Name: "en1", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:02")},
	}
	b := []net.Interface{
		{Name: "en1", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:02")},
		{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:01")},
	}

	if got, want := MachineFingerprint(b), MachineFingerprint(a); got != want {
		t.Fatalf("reordering interfaces changed the fingerprint: %q vs %q", got, want)
	}
	if MachineFingerprint(a) == "" {
		t.Fatal("fingerprint is empty for a machine with real interfaces")
	}
}

func TestMachineFingerprintDiffersBetweenMachines(t *testing.T) {
	a := MachineFingerprint([]net.Interface{{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:01")}})
	b := MachineFingerprint([]net.Interface{{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:02")}})
	if a == b {
		t.Fatalf("two machines share a fingerprint: %q", a)
	}
}

func TestMachineFingerprintIgnoresVirtualInterfaces(t *testing.T) {
	// Docker, VM, and VPN interfaces come and go and get fresh MACs each time.
	// Counting them would make the fingerprint change whenever Docker starts,
	// which would look like the config had been copied to another machine.
	physical := []net.Interface{{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:01")}}
	withVirtual := []net.Interface{
		{Name: "en0", HardwareAddr: hw(t, "aa:bb:cc:dd:ee:01")},
		{Name: "docker0", HardwareAddr: hw(t, "02:42:9a:00:00:01")},
		{Name: "vmnet1", HardwareAddr: hw(t, "00:50:56:c0:00:01")},
		{Name: "bridge100", HardwareAddr: hw(t, "36:7d:da:80:00:64")},
		{Name: "utun4", HardwareAddr: hw(t, "aa:00:00:00:00:99")},
	}

	if got, want := MachineFingerprint(withVirtual), MachineFingerprint(physical); got != want {
		t.Fatalf("virtual interfaces changed the fingerprint: %q vs %q", got, want)
	}
}

func TestMachineFingerprintEmptyWhenNoHardwareAddresses(t *testing.T) {
	// A container with only loopback. Callers must treat "" as "cannot bind an
	// identity to this machine" rather than as a valid fingerprint.
	got := MachineFingerprint([]net.Interface{{Name: "lo0", Flags: net.FlagLoopback}})
	if got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestEnsureIdentityCreatesAndPersistsAHostID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mobile", "identity.json")

	got, err := EnsureIdentity(path, "fingerprint-a")
	if err != nil {
		t.Fatalf("EnsureIdentity: %v", err)
	}
	if got.HostID == "" {
		t.Fatal("no host id generated")
	}
	if !strings.HasPrefix(got.HostID, "h_") {
		t.Fatalf("host id %q lacks the h_ prefix", got.HostID)
	}

	// It must survive a daemon restart, or every restart would invalidate every
	// paired phone's stored host identity.
	again, err := EnsureIdentity(path, "fingerprint-a")
	if err != nil {
		t.Fatalf("second EnsureIdentity: %v", err)
	}
	if again.HostID != got.HostID {
		t.Fatalf("host id changed across restart: %q then %q", got.HostID, again.HostID)
	}
}

func TestEnsureIdentityRegeneratesWhenCarriedToAnotherMachine(t *testing.T) {
	// A copied ~/.ao must not let machine B answer as machine A. Regenerating
	// (rather than erroring) is deliberate: the phone's stored hostId then
	// simply stops matching and it refuses the endpoint, while machine B keeps
	// working. Erroring would brick the daemon on a swapped network card.
	path := filepath.Join(t.TempDir(), "mobile", "identity.json")

	original, err := EnsureIdentity(path, "fingerprint-a")
	if err != nil {
		t.Fatalf("EnsureIdentity: %v", err)
	}

	moved, err := EnsureIdentity(path, "fingerprint-b")
	if err != nil {
		t.Fatalf("EnsureIdentity after move: %v", err)
	}
	if moved.HostID == original.HostID {
		t.Fatalf("copied config kept host id %q — machine B can impersonate machine A", moved.HostID)
	}
	if moved.Fingerprint != "fingerprint-b" {
		t.Fatalf("fingerprint not rebound: got %q", moved.Fingerprint)
	}
}

func TestEnsureIdentityWritesOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mobile", "identity.json")
	if _, err := EnsureIdentity(path, "fingerprint-a"); err != nil {
		t.Fatalf("EnsureIdentity: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("identity file mode %o, want 600", perm)
	}
}
