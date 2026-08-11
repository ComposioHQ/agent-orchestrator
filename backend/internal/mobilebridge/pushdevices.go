package mobilebridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PushDevice is one registered phone that should receive push notifications.
// InstallID is the unique key: a phone generates it once per install and keeps
// it across push-token rotations, so a rotated Expo push token updates the
// existing row instead of creating a second one. It does not survive a full
// uninstall/reinstall, since it's stored in AsyncStorage, which uninstall
// wipes. Muted devices stay registered and listed but are skipped by the
// dispatcher.
type PushDevice struct {
	InstallID  string    `json:"installId"`
	Token      string    `json:"token,omitempty"`
	Platform   string    `json:"platform,omitempty"`
	DeviceName string    `json:"deviceName,omitempty"`
	Muted      bool      `json:"muted,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

// removedDevice is a tombstone recording a device the desktop explicitly
// removed. If that device (matched by InstallID or Token) ever registers
// again, it comes back muted rather than silently active, since there is no
// per-device credential to revoke — every phone shares the same connection
// password, so removal cannot stop it from reconnecting.
type removedDevice struct {
	InstallID string    `json:"installId"`
	Token     string    `json:"token,omitempty"`
	RemovedAt time.Time `json:"removedAt"`
}

// pushDevicesFile is the on-disk shape, wrapped in a struct (rather than a bare
// array) so future fields can be added without breaking older files.
type pushDevicesFile struct {
	Devices []PushDevice    `json:"devices"`
	Removed []removedDevice `json:"removed,omitempty"`
}

// maxTombstones caps how many removal tombstones persist, so the file cannot
// grow without bound. Oldest tombstones are dropped first.
const maxTombstones = 50

// expoPushTokenRE matches the two Expo push-token spellings with a non-empty body.
var expoPushTokenRE = regexp.MustCompile(`^Expo(nent)?PushToken\[[^\]]+\]$`)

// ValidPushToken reports whether tok is a well-formed Expo push token. The daemon
// rejects anything else before storing so garbage can't accumulate in the registry.
func ValidPushToken(tok string) bool {
	return expoPushTokenRE.MatchString(tok)
}

// PushDevicesPath returns the push-device registry location under the data dir
// (~/.ao/mobile/push-devices.json), co-located with the Connect Mobile config.
func PushDevicesPath(dataDir string) string {
	return filepath.Join(dataDir, "mobile", "push-devices.json")
}

// DeviceRegistry is the in-memory, mutex-guarded push-device registry backed by a
// JSON file. Reads (List) serve the push dispatcher's hot path without touching
// disk; mutations (Upsert/Delete) persist the whole file atomically.
type DeviceRegistry struct {
	mu      sync.RWMutex
	path    string
	devices map[string]PushDevice // keyed by InstallID
	removed []removedDevice       // tombstones from explicit Delete calls, newest last
}

// LoadRegistry reads the registry at path into memory, keyed by install ID. A
// missing file is not an error: it yields an empty registry. Rows written before
// install IDs existed get one synthesized here and the file is rewritten once, so
// the key is never empty at runtime.
func LoadRegistry(path string) (*DeviceRegistry, error) {
	reg := &DeviceRegistry{path: path, devices: map[string]PushDevice{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return reg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read push devices: %w", err)
	}
	var file pushDevicesFile
	if err := json.Unmarshal(b, &file); err != nil {
		return nil, fmt.Errorf("parse push devices: %w", err)
	}
	migrated := false
	for _, d := range file.Devices {
		// A row with neither a token nor an install ID carries no identity at
		// all — there is nothing to key it on and nothing worth synthesizing an
		// id for, so it is dropped rather than kept or multiplied across
		// reloads. Every other shape (tokenless-but-identified, or legacy
		// tokened-but-unidentified) is preserved: a row represents a paired
		// phone, not a push registration, so an empty token alone is not a
		// reason to discard it.
		if d.Token == "" && d.InstallID == "" {
			continue
		}
		if d.InstallID == "" {
			d.InstallID = "legacy-" + uuid.NewString()
			migrated = true
		}
		reg.devices[d.InstallID] = d
	}
	reg.removed = file.Removed
	if migrated {
		reg.mu.Lock()
		err := reg.persistLocked()
		reg.mu.Unlock()
		if err != nil {
			return nil, fmt.Errorf("persist migrated push devices: %w", err)
		}
	}
	return reg, nil
}

// Upsert registers or refreshes a device.
//
// A phone can reach us under two identities at once. On upgrade the registry
// holds a legacy row that owns its push token, while the phone announces its
// real install id (tokenless) and registers that same id (with token) from two
// independent effects. If the announce lands first, resolving by install id
// alone would update the new row and leave the legacy row still holding the
// token — two rows, one token, every notification delivered twice. That is the
// precise defect install ids exist to prevent, so resolution consults BOTH keys
// and reconciles them:
//
//   - both match (different rows): merge into the install-id row, drop the
//     token row.
//   - only the install id matches: update that row.
//   - only the token matches: re-key that row onto the incoming install id.
//   - neither: insert.
//
// The token lookup is skipped when the incoming token is empty — otherwise
// every tokenless announce would adopt an arbitrary tokenless row.
//
// CreatedAt, Muted, and (when the incoming Token is empty) the existing Token
// always survive, so neither a reinstall, a token rotation, nor a plain
// identity announce can silently unmute a device or blank a working token.
//
// A row represents a paired phone, not a push registration: Token is optional.
// When non-empty it must still be a well-formed Expo push token.
func (r *DeviceRegistry) Upsert(dev PushDevice) error {
	if dev.Token != "" && !ValidPushToken(dev.Token) {
		return fmt.Errorf("invalid push token %q", dev.Token)
	}
	if dev.InstallID == "" {
		return fmt.Errorf("install id required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	byInstall, hasInstall := r.devices[dev.InstallID]
	tokenKey, byToken, hasToken := r.findByTokenLocked(dev.Token, dev.InstallID)

	switch {
	case hasInstall && hasToken:
		// Same phone, two identities. Fold them together before writing, so the
		// token is never left behind on the row being abandoned.
		dev.CreatedAt, dev.Muted, dev.Token = carryOver(mergeIdentities(byInstall, byToken), dev)
		delete(r.devices, tokenKey)
	case hasInstall:
		dev.CreatedAt, dev.Muted, dev.Token = carryOver(byInstall, dev)
	case hasToken:
		dev.CreatedAt, dev.Muted, dev.Token = carryOver(byToken, dev)
		delete(r.devices, tokenKey) // re-key from the legacy/synthesized id
	}
	r.consumeTombstoneLocked(&dev)
	r.devices[dev.InstallID] = dev
	return r.persistLocked()
}

// consumeTombstoneLocked mutes dev and removes the first matching tombstone
// (by InstallID or Token) if one exists. The match is consumed so a device
// the user later unmutes is never re-muted by a stale tombstone. Callers
// must hold r.mu.
func (r *DeviceRegistry) consumeTombstoneLocked(dev *PushDevice) {
	for i, t := range r.removed {
		if t.InstallID == dev.InstallID || (dev.Token != "" && t.Token == dev.Token) {
			dev.Muted = true
			r.removed = append(r.removed[:i], r.removed[i+1:]...)
			return
		}
	}
}

// findByTokenLocked returns the row holding token, ignoring the row already
// keyed by skipInstallID (that one is found by install id instead, and treating
// it as a second identity would make a device merge with itself). An empty
// token matches nothing: tokenless rows are distinct phones, not candidates for
// adoption. Callers must hold r.mu.
func (r *DeviceRegistry) findByTokenLocked(token, skipInstallID string) (key string, dev PushDevice, ok bool) {
	if token == "" {
		return "", PushDevice{}, false
	}
	for k, existing := range r.devices {
		if k != skipInstallID && existing.Token == token {
			return k, existing, true
		}
	}
	return "", PushDevice{}, false
}

// mergeIdentities folds two rows that turn out to be the same phone into the
// one that survives. The oldest CreatedAt wins so "paired since" never jumps
// forward, the newest LastSeenAt wins, and Muted is sticky: if EITHER identity
// was muted the merged row stays muted, so reconciling can never silently
// re-enable notifications the user turned off. Descriptive fields fill in from
// whichever row has them, since a tokenless announce may carry a device name
// the legacy row lacks.
func mergeIdentities(primary, other PushDevice) PushDevice {
	out := primary
	if !other.CreatedAt.IsZero() && (out.CreatedAt.IsZero() || other.CreatedAt.Before(out.CreatedAt)) {
		out.CreatedAt = other.CreatedAt
	}
	if other.LastSeenAt.After(out.LastSeenAt) {
		out.LastSeenAt = other.LastSeenAt
	}
	out.Muted = primary.Muted || other.Muted
	if out.Token == "" {
		out.Token = other.Token
	}
	if out.DeviceName == "" {
		out.DeviceName = other.DeviceName
	}
	if out.Platform == "" {
		out.Platform = other.Platform
	}
	return out
}

// carryOver preserves the fields an incoming registration must never reset:
// CreatedAt and Muted always survive from the existing row, and an incoming
// empty Token never blanks an existing one — an identity announce (no token)
// must not silently disable notifications on a phone that already had them
// working.
func carryOver(existing, incoming PushDevice) (createdAt time.Time, muted bool, token string) {
	created := incoming.CreatedAt
	if !existing.CreatedAt.IsZero() {
		created = existing.CreatedAt
	}
	token = incoming.Token
	if token == "" {
		token = existing.Token
	}
	return created, existing.Muted, token
}

// Delete removes a device by install ID (the desktop's remove action) and
// records a tombstone so a re-registration comes back muted instead of
// silently active — there is no per-device credential to actually revoke.
// Deleting an unknown id is a no-op.
func (r *DeviceRegistry) Delete(installID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dev, ok := r.devices[installID]
	if !ok {
		return nil
	}
	delete(r.devices, installID)
	r.removed = append(r.removed, removedDevice{
		InstallID: dev.InstallID,
		Token:     dev.Token,
		RemovedAt: time.Now().UTC(),
	})
	if len(r.removed) > maxTombstones {
		r.removed = r.removed[len(r.removed)-maxTombstones:]
	}
	return r.persistLocked()
}

// DeleteByToken removes a device by push token. Used by the phone's
// unregister-on-disconnect and by the dispatcher's dead-token pruning, neither
// of which knows an install ID. Unknown tokens are a no-op.
func (r *DeviceRegistry) DeleteByToken(token string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, dev := range r.devices {
		if dev.Token == token {
			delete(r.devices, key)
			return r.persistLocked()
		}
	}
	return nil
}

// SetMuted flips a device's mute flag. Unknown install ids return an error so
// the API can answer 404 rather than silently succeeding.
func (r *DeviceRegistry) SetMuted(installID string, muted bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dev, ok := r.devices[installID]
	if !ok {
		return fmt.Errorf("unknown device %q", installID)
	}
	dev.Muted = muted
	r.devices[installID] = dev
	return r.persistLocked()
}

// List returns a snapshot of all registered devices, sorted by CreatedAt (then
// token) for stable output. The push dispatcher iterates this per event.
func (r *DeviceRegistry) List() []PushDevice {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PushDevice, 0, len(r.devices))
	for _, d := range r.devices {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].Token < out[j].Token
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

// persistLocked writes the current device set to disk atomically (temp file +
// rename, 0600), creating the parent dir if needed. Callers must hold r.mu.
func (r *DeviceRegistry) persistLocked() error {
	devices := make([]PushDevice, 0, len(r.devices))
	for _, d := range r.devices {
		devices = append(devices, d)
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].Token < devices[j].Token })

	b, err := json.MarshalIndent(pushDevicesFile{Devices: devices, Removed: r.removed}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return fmt.Errorf("mkdir mobile dir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.path), ".push-devices-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, r.path)
}
