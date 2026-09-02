// Package ptyregistry is a sideband JSON list of live detached pty-host
// processes. Native runtimes use it to recover hosts across daemon restarts
// and to stop them even when in-memory session state is lost. The on-disk
// filename is retained from the original windows-pty-registry.ts format.
package ptyregistry

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	// ErrEntryExists prevents Create from replacing a recovery owner that
	// appeared after its pre-spawn check.
	ErrEntryExists = errors.New("pty-host registry entry already exists")
	// ErrEntryChanged prevents teardown from deleting a later host generation
	// that reused the same session id.
	ErrEntryChanged = errors.New("pty-host registry entry changed")
)

// Entry is one registered pty-host process.
type Entry struct {
	SessionID  string `json:"sessionId"`
	PtyHostPID int    `json:"ptyHostPid"`
	PipePath   string `json:"pipePath"`
	// LaunchID is absent on pre-generation registries and auxiliary hosts such
	// as reviewer terminals. Those entries remain readable for compatibility,
	// but the runtime's managed-session resolver rejects an empty launch id as
	// insufficient ownership proof.
	LaunchID string `json:"launchId,omitempty"`
	// HostToken is a random immutable credential held by the detached host and
	// its registry entry. Entries written before authenticated host identity was
	// introduced omit it; callers may adopt those protocol-v2 hosts only after
	// the platform-specific OS identity proof succeeds.
	HostToken    string `json:"hostToken,omitempty"`
	RegisteredAt string `json:"registeredAt"` // RFC3339; set by caller
}

// pidAlive is the PID-liveness probe. Tests replace it with a fake.
// defaultPidAlive is provided in build-tagged files (pidalive_unix.go /
// pidalive_windows.go).
var pidAlive = defaultPidAlive

// overrideDir, when set, is the directory the registry file lives in for
// this daemon instance, taking precedence over the ~/.ao default. Set once by
// SetRunFilePath at daemon startup, before any session activity begins, so
// the unsynchronized package var has no concurrent access to race against.
var overrideDir string

// registryMu makes each read-modify-write operation atomic within the daemon.
// Session starts can run concurrently; without this lock two successful hosts
// could race and leave only one recoverable registry entry on disk.
var registryMu sync.Mutex

// SetRunFilePath pins the registry to the directory containing this
// instance's running.json (backend/internal/config's already-resolved,
// absolute Config.RunFilePath). Two AO daemons on one machine — e.g. a
// headless dev daemon and the desktop app, or two dev daemons — normally run
// fully isolated via AO_RUN_FILE/AO_DATA_DIR overrides, but the registry
// ignored that and always resolved to ~/.ao regardless: with the same
// project checked out in both, their independently-numbered session ids
// (e.g. "demo-website-2") could collide, and the second instance's
// registration would silently overwrite the first's pty-host address,
// attaching that session's terminal to the wrong process. Co-locating the
// registry with each instance's own running.json keeps them isolated the
// same way the SQLite store already is. An empty path clears any override,
// reverting to the ~/.ao default.
func SetRunFilePath(path string) {
	if path == "" {
		overrideDir = ""
		return
	}
	overrideDir = filepath.Dir(path)
}

// registryFile resolves the pty-host registry path: overrideDir joined with
// the registry filename when set via SetRunFilePath, otherwise
// ~/.ao/windows-pty-hosts.json via os.UserHomeDir() so t.Setenv("HOME", dir)
// in tests redirects reads/writes to a temp dir.
func registryFile() (string, error) {
	if overrideDir != "" {
		return filepath.Join(overrideDir, "windows-pty-hosts.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ao", "windows-pty-hosts.json"), nil
}

// readRaw reads and validates the registry. A missing file conclusively means
// there are no registered hosts. Every other read or decode failure is
// preserved: treating an unreadable registry as empty can make recovery launch
// a second workload while the original detached host is still alive.
func readRaw() ([]Entry, error) {
	path, err := registryFile()
	if err != nil {
		return nil, fmt.Errorf("resolve pty-host registry: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read pty-host registry %q: %w", path, err)
	}
	var parsed []json.RawMessage
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("decode pty-host registry %q: %w", path, err)
	}
	if parsed == nil && strings.TrimSpace(string(data)) != "[]" {
		return nil, fmt.Errorf("decode pty-host registry %q: expected a JSON array", path)
	}
	out := make([]Entry, 0, len(parsed))
	seen := make(map[string]struct{}, len(parsed))
	for i, raw := range parsed {
		var e Entry
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, fmt.Errorf("decode pty-host registry %q entry %d: %w", path, i, err)
		}
		if err := validateEntry(e); err != nil {
			return nil, fmt.Errorf("decode pty-host registry %q entry %d: %w", path, i, err)
		}
		if _, duplicate := seen[e.SessionID]; duplicate {
			return nil, fmt.Errorf("decode pty-host registry %q entry %d: duplicate session id %q", path, i, e.SessionID)
		}
		seen[e.SessionID] = struct{}{}
		out = append(out, e)
	}
	return out, nil
}

func validateEntry(entry Entry) error {
	if strings.TrimSpace(entry.SessionID) == "" {
		return errors.New("session id is required")
	}
	if entry.PtyHostPID <= 0 {
		return errors.New("pty-host pid must be positive")
	}
	if strings.TrimSpace(entry.PipePath) == "" {
		return errors.New("pty-host address is required")
	}
	return nil
}

// writeRaw atomically writes entries to the registry file. When entries is
// empty it deletes the file instead (mirrors writeRaw in the TS source).
func writeRaw(entries []Entry) error {
	path, err := registryFile()
	if err != nil {
		return err
	}

	if len(entries) == 0 {
		err := os.Remove(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}

	// Atomic write: temp file in same dir then rename (same filesystem).
	tmp, err := os.CreateTemp(dir, "pty-hosts-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		// Best-effort cleanup of temp file on failure.
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return replaceRegistryFile(tmpName, path)
}

// Register adds or replaces the entry for entry.SessionID. registeredAt must
// be set by the caller (e.g. time.Now().UTC().Format(time.RFC3339)).
func Register(entry Entry) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	if err := validateEntry(entry); err != nil {
		return fmt.Errorf("register pty-host: %w", err)
	}
	all, err := readRaw()
	if err != nil {
		return err
	}
	next := make([]Entry, 0)
	for _, e := range all {
		if e.SessionID != entry.SessionID {
			next = append(next, e)
		}
	}
	next = append(next, entry)
	return writeRaw(next)
}

// RegisterIfAbsent publishes entry only if no owner is currently registered
// for its session id. Runtime.Create uses this after spawning so a concurrent
// owner can never be silently overwritten; fixtures and explicit migrations
// may continue to use Register's replace semantics.
func RegisterIfAbsent(entry Entry) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	if err := validateEntry(entry); err != nil {
		return fmt.Errorf("register pty-host: %w", err)
	}
	all, err := readRaw()
	if err != nil {
		return err
	}
	for _, existing := range all {
		if existing.SessionID == entry.SessionID {
			return fmt.Errorf("session %q: %w", entry.SessionID, ErrEntryExists)
		}
	}
	return writeRaw(append(all, entry))
}

// Unregister removes the entry for sessionID. No-op if absent.
func Unregister(sessionID string) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	all, err := readRaw()
	if err != nil {
		return err
	}
	next := make([]Entry, 0, len(all))
	for _, e := range all {
		if e.SessionID != sessionID {
			next = append(next, e)
		}
	}
	if len(next) == len(all) {
		return nil // absent, no-op
	}
	return writeRaw(next)
}

// UnregisterExact removes only the exact durable host generation supplied by
// the caller. It is idempotent when the session is absent and fails with
// ErrEntryChanged when a later generation now owns the same session id.
func UnregisterExact(entry Entry) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	if err := validateEntry(entry); err != nil {
		return fmt.Errorf("unregister exact pty-host: %w", err)
	}
	all, err := readRaw()
	if err != nil {
		return err
	}
	next := make([]Entry, 0, len(all))
	found := false
	for _, existing := range all {
		if existing.SessionID != entry.SessionID {
			next = append(next, existing)
			continue
		}
		found = true
		if existing != entry {
			return fmt.Errorf("session %q: %w", entry.SessionID, ErrEntryChanged)
		}
	}
	if !found {
		return nil
	}
	return writeRaw(next)
}

// List returns every durable entry. PID liveness is deliberately not used to
// prune here: a reused PID is not proof that the registered host is alive, and
// registry cleanup is safe only after the runtime has authenticated the exact
// host identity (or proved the recorded PID is gone).
func List() ([]Entry, error) {
	registryMu.Lock()
	defer registryMu.Unlock()
	return readRaw()
}

// Clear deletes the registry file. Best-effort; used by tests and recovery.
func Clear() error {
	registryMu.Lock()
	defer registryMu.Unlock()
	return writeRaw(nil)
}
