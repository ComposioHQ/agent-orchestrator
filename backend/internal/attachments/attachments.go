// Package attachments owns the canonical bytes for files a user attaches to a
// session. The worktree copy under .ao/attachments is a projection for the
// agent; it lives in a disposable git worktree that daemon recovery recreates,
// which is exactly when a worktree-only attachment disappears while the durable
// conversation still points at it (#3884). The canonical copy lives under AO's
// data dir and shares the conversation's lifetime instead of the worktree's.
package attachments

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// WorktreeDir is the worktree-relative directory attachments are projected
// into. It matches the references embedded in durable conversation history, so
// it can never change without a migration for every stored message.
const WorktreeDir = ".ao/attachments"

// Dir returns the canonical directory for one session's attachments.
func Dir(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "attachments", sessionID)
}

// ValidName reports whether name is a bare filename AO could have generated for
// an attachment. It is the gate between a request path and the filesystem: no
// separators, no traversal, no hidden files, ASCII-safe charset only.
func ValidName(name string) bool {
	if name == "" || len(name) > 255 {
		return false
	}
	if name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}

// RefName extracts and validates the filename from a worktree-relative
// attachment reference like ".ao/attachments/attachment-ab12cd.png". It reports
// false for anything that is not a well-formed AO attachment reference.
func RefName(ref string) (string, bool) {
	rest, ok := strings.CutPrefix(filepath.ToSlash(ref), WorktreeDir+"/")
	if !ok {
		return "", false
	}
	if !ValidName(rest) {
		return "", false
	}
	return rest, true
}

// Store writes one canonical attachment atomically: the bytes land in a temp
// file first and are renamed into place, so a crash mid-write can never leave a
// half-written file that later serves as the "durable" copy.
func Store(dataDir, sessionID, name string, data []byte) error {
	if dataDir == "" {
		return errors.New("attachments: data dir is required")
	}
	if !ValidName(name) {
		return fmt.Errorf("attachments: invalid name %q", name)
	}
	dir := Dir(dataDir, sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("attachments: create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-"+name+"-*")
	if err != nil {
		return fmt.Errorf("attachments: temp file for %s: %w", name, err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("attachments: chmod %s: %w", name, err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("attachments: write %s: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("attachments: close %s: %w", name, err)
	}
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		return fmt.Errorf("attachments: commit %s: %w", name, err)
	}
	return nil
}

// Open opens the canonical copy of one attachment for serving. The name is
// validated before it touches the filesystem, and only regular files are
// served — a symlink planted in the canonical dir must not become an escape.
func Open(dataDir, sessionID, name string) (*os.File, os.FileInfo, error) {
	if dataDir == "" || !ValidName(name) {
		return nil, nil, fs.ErrNotExist
	}
	path := filepath.Join(Dir(dataDir, sessionID), name)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fs.ErrNotExist
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	return file, info, nil
}

// Materialize projects every canonical attachment for the session into the
// worktree so the agent can read the same .ao/attachments/... paths its
// conversation history names. Existing worktree files are left alone: the
// worktree copy of a name that exists in both places is at least as new.
func Materialize(dataDir, sessionID, workspacePath string) (int, error) {
	if dataDir == "" || workspacePath == "" {
		return 0, nil
	}
	entries, err := os.ReadDir(Dir(dataDir, sessionID))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("attachments: read canonical dir: %w", err)
	}
	dest := filepath.Join(workspacePath, filepath.FromSlash(WorktreeDir))
	copied := 0
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !ValidName(entry.Name()) {
			continue
		}
		target := filepath.Join(dest, entry.Name())
		if _, err := os.Lstat(target); err == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(Dir(dataDir, sessionID), entry.Name()))
		if err != nil {
			return copied, fmt.Errorf("attachments: read canonical %s: %w", entry.Name(), err)
		}
		if copied == 0 {
			if err := os.MkdirAll(dest, 0o750); err != nil {
				return copied, fmt.Errorf("attachments: create %s: %w", dest, err)
			}
		}
		if err := os.WriteFile(target, data, 0o600); err != nil {
			return copied, fmt.Errorf("attachments: materialize %s: %w", entry.Name(), err)
		}
		copied++
	}
	return copied, nil
}

// ImportWorktree copies attachments that exist only in the worktree into
// canonical storage. This is the upgrade path for attachments staged by builds
// that wrote worktree-only copies: it runs before the destructive teardown that
// would otherwise delete their only bytes. Names already present canonically
// are skipped, so re-running is cheap and idempotent.
func ImportWorktree(dataDir, sessionID, workspacePath string) (int, error) {
	if dataDir == "" || workspacePath == "" {
		return 0, nil
	}
	src := filepath.Join(workspacePath, filepath.FromSlash(WorktreeDir))
	entries, err := os.ReadDir(src)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("attachments: read worktree dir: %w", err)
	}
	imported := 0
	for _, entry := range entries {
		// Symlinks are deliberately not followed: a link out of the worktree must
		// not be able to pull arbitrary files into durable storage.
		if !entry.Type().IsRegular() || !ValidName(entry.Name()) {
			continue
		}
		if _, err := os.Lstat(filepath.Join(Dir(dataDir, sessionID), entry.Name())); err == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, entry.Name()))
		if err != nil {
			return imported, fmt.Errorf("attachments: read worktree %s: %w", entry.Name(), err)
		}
		if err := Store(dataDir, sessionID, entry.Name(), data); err != nil {
			return imported, err
		}
		imported++
	}
	return imported, nil
}

// Remove deletes the session's canonical attachment directory. Only for
// permanent deletion of the owning session — never for runtime teardown or
// worktree recycling, which is exactly the mistake that motivated this package.
func Remove(dataDir, sessionID string) error {
	if dataDir == "" || sessionID == "" {
		return nil
	}
	return os.RemoveAll(Dir(dataDir, sessionID))
}
