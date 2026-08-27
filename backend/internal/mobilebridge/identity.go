package mobilebridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"

	"github.com/google/uuid"
)

// MachineFingerprint derives a stable identifier for this physical machine from
// its hardware addresses. It is a heuristic, used only to notice that a copied
// ~/.ao has been carried to a different machine — never as a secret.
//
// Deliberately independent of interface order (net.Interfaces() gives no
// ordering guarantee) and of link state (Wi-Fi being off must not look like a
// different machine).
func MachineFingerprint(ifaces []net.Interface) string {
	var macs []string
	for _, i := range ifaces {
		if len(i.HardwareAddr) == 0 || hasVirtualName(i.Name) {
			continue
		}
		macs = append(macs, i.HardwareAddr.String())
	}
	if len(macs) == 0 {
		return ""
	}
	sort.Strings(macs)
	h := sha256.New()
	for _, m := range macs {
		h.Write([]byte(m))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// Identity is the daemon's stable, machine-bound identity as seen by paired
// phones. It is not a secret: the phone compares the HostID it paired with
// against the one /api/v1/identity reports, so that a private address reused on
// a different network cannot be mistaken for the paired machine.
type Identity struct {
	HostID string `json:"hostId"`
	// Fingerprint is the MachineFingerprint this HostID was issued for. A
	// mismatch means the file was carried to another machine.
	Fingerprint string `json:"fingerprint"`
}

// IdentityPath returns the identity file location under the data dir
// (~/.ao/mobile/identity.json).
func IdentityPath(dataDir string) string {
	return filepath.Join(dataDir, "mobile", "identity.json")
}

// EnsureIdentity loads the identity at path, or issues a new one when the file
// is missing, unreadable, or was issued for a different machine.
//
// Rebinding on a fingerprint mismatch is deliberate. A copied ~/.ao must not let
// another machine answer as this one, but failing hard would brick the daemon
// after something as ordinary as a replaced network card. Reissuing keeps the
// daemon working while the phone's stored hostId simply stops matching, which
// is exactly the check the race already performs.
func EnsureIdentity(path, fingerprint string) (Identity, error) {
	if b, err := os.ReadFile(path); err == nil {
		var existing Identity
		if json.Unmarshal(b, &existing) == nil &&
			existing.HostID != "" &&
			existing.Fingerprint == fingerprint {
			return existing, nil
		}
	} else if !os.IsNotExist(err) {
		return Identity{}, fmt.Errorf("read mobile identity: %w", err)
	}

	issued := Identity{HostID: "h_" + uuid.NewString(), Fingerprint: fingerprint}
	if err := writeIdentity(path, issued); err != nil {
		return Identity{}, err
	}
	return issued, nil
}

func writeIdentity(path string, id Identity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir mobile dir: %w", err)
	}
	b, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("write mobile identity: %w", err)
	}
	return nil
}

// EnsureLocalIdentity is the production entry point: this machine's identity,
// bound to its real interfaces, under the given data dir. A thin wrapper over
// the tested EnsureIdentity/MachineFingerprint pair, in the style of
// AutopickLANIP.
func EnsureLocalIdentity(dataDir string) (Identity, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return Identity{}, fmt.Errorf("read interfaces: %w", err)
	}
	return EnsureIdentity(IdentityPath(dataDir), MachineFingerprint(ifaces))
}
