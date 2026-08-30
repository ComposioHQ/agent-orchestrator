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
	// Fingerprint is the aggregate MachineFingerprint this HostID was issued
	// for. Retained for identities written before Fingerprints existed.
	Fingerprint string `json:"fingerprint"`
	// Fingerprints is one hash per hardware interface.
	//
	// The aggregate above hashes every interface together, so it changes
	// whenever the *set* changes — a dock, a replaced network card, an OS
	// update renaming an interface — and each of those reissued the host id and
	// silently unpaired every phone. Holding them separately lets the machine
	// still be recognised when one comes or goes, while a machine with nothing
	// in common is still treated as different, which is the point of binding at
	// all: a copied ~/.ao must not answer as the original and collect a phone's
	// token.
	Fingerprints []string `json:"fingerprints,omitempty"`
}

// IdentityPath returns the identity file location under the data dir
// (~/.ao/mobile/identity.json).
func IdentityPath(dataDir string) string {
	return filepath.Join(dataDir, "mobile", "identity.json")
}

// InterfaceFingerprints hashes each hardware interface separately, skipping
// virtual ones exactly as MachineFingerprint does.
func InterfaceFingerprints(ifaces []net.Interface) []string {
	var out []string
	for _, i := range ifaces {
		if len(i.HardwareAddr) == 0 || hasVirtualName(i.Name) {
			continue
		}
		h := sha256.Sum256([]byte(i.HardwareAddr.String()))
		out = append(out, hex.EncodeToString(h[:])[:32])
	}
	sort.Strings(out)
	return out
}

// sameMachine is true when the two sets share any interface.
//
// One in common is deliberately enough. Requiring a majority would fail a
// laptop that lost its only built-in NIC to a dock, and the binding is not a
// secret — it stops a *copy* claiming the original's identity, and a copy
// shares no hardware at all.
func sameMachine(stored, current []string) bool {
	have := make(map[string]bool, len(stored))
	for _, f := range stored {
		have[f] = true
	}
	for _, f := range current {
		if have[f] {
			return true
		}
	}
	return false
}

// EnsureIdentityFor loads the identity at path, keeping its host id when the
// machine is recognisable and issuing a new one when it is not.
func EnsureIdentityFor(path string, ifaces []net.Interface) (Identity, error) {
	current := InterfaceFingerprints(ifaces)
	aggregate := MachineFingerprint(ifaces)

	if b, err := os.ReadFile(path); err == nil {
		var existing Identity
		if json.Unmarshal(b, &existing) == nil && existing.HostID != "" {
			switch {
			case len(existing.Fingerprints) > 0 && sameMachine(existing.Fingerprints, current):
				// Known machine whose interfaces moved: rebind to what is here
				// now, so the next change is measured against the current set.
				if !equalStrings(existing.Fingerprints, current) {
					existing.Fingerprints = current
					existing.Fingerprint = aggregate
					if err := writeIdentity(path, existing); err != nil {
						return Identity{}, err
					}
				}
				return existing, nil
			case len(existing.Fingerprints) == 0 && existing.Fingerprint == aggregate:
				// Written before per-interface hashes existed. Same machine by
				// the old measure, so keep the id and upgrade the record.
				existing.Fingerprints = current
				if err := writeIdentity(path, existing); err != nil {
					return Identity{}, err
				}
				return existing, nil
			case len(current) == 0 && len(existing.Fingerprints) == 0 && existing.Fingerprint == "":
				// No hardware addresses to bind to, on a machine that had none
				// when the id was issued. Churning the id every start would be
				// worse than an unbound identity.
				return existing, nil
			}
		}
	} else if !os.IsNotExist(err) {
		return Identity{}, fmt.Errorf("read mobile identity: %w", err)
	}

	issued := Identity{
		HostID:       "h_" + uuid.NewString(),
		Fingerprint:  aggregate,
		Fingerprints: current,
	}
	if err := writeIdentity(path, issued); err != nil {
		return Identity{}, err
	}
	return issued, nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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
	return EnsureIdentityFor(IdentityPath(dataDir), ifaces)
}
