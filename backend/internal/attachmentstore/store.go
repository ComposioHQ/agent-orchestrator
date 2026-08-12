// Package attachmentstore owns the durable copy of files attached to session
// messages. Worktree copies are projections for agents; the canonical bytes
// live under AO's data directory so worktree teardown cannot erase history.
package attachmentstore

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	// WorkspaceDir is the worktree-relative directory named in chat messages.
	WorkspaceDir = ".ao/attachments"
	durableDir   = "attachments"
)

// Store persists canonical attachment bytes beneath an AO data directory.
// An empty data directory disables canonical persistence for narrow unit tests
// while retaining worktree projection behavior.
type Store struct {
	root string
}

// New returns a store rooted at dataDir. An empty dataDir keeps only the
// worktree projection behavior used by narrow embedders and tests.
func New(dataDir string) *Store {
	root := ""
	if strings.TrimSpace(dataDir) != "" {
		root = filepath.Join(dataDir, durableDir)
	}
	return &Store{root: root}
}

// Put writes the canonical copy before projecting it into the live worktree.
// Returning success therefore means both the history copy and the agent-visible
// copy exist.
func (s *Store) Put(id domain.SessionID, workspacePath, name string, data []byte) error {
	if err := validateSessionID(id); err != nil {
		return err
	}
	if err := validateName(name); err != nil {
		return err
	}
	if s.root != "" {
		if err := writeFileAtomic(s.sessionDir(id), name, data); err != nil {
			return fmt.Errorf("write canonical attachment: %w", err)
		}
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("attachment workspace path is empty")
	}
	if err := writeFileAtomic(filepath.Join(workspacePath, filepath.FromSlash(WorkspaceDir)), name, data); err != nil {
		return fmt.Errorf("write workspace attachment: %w", err)
	}
	return nil
}

// ImportWorkspace migrates legacy worktree-only attachments into canonical
// storage. Existing canonical files win because they are already the durable
// source of truth. Symlinks and non-regular entries are ignored.
func (s *Store) ImportWorkspace(id domain.SessionID, workspacePath string) error {
	if s.root == "" {
		return nil
	}
	if err := validateSessionID(id); err != nil {
		return err
	}
	sourceDir := filepath.Join(workspacePath, filepath.FromSlash(WorkspaceDir))
	info, err := os.Lstat(sourceDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect workspace attachments: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("workspace attachments path is not a directory")
	}
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return fmt.Errorf("list workspace attachments: %w", err)
	}
	root, err := os.OpenRoot(workspacePath)
	if err != nil {
		return fmt.Errorf("open workspace root: %w", err)
	}
	defer func() { _ = root.Close() }()

	for _, entry := range entries {
		if temporaryName(entry.Name()) || entry.Type()&os.ModeSymlink != 0 || validateName(entry.Name()) != nil {
			continue
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return fmt.Errorf("inspect workspace attachment %q: %w", entry.Name(), infoErr)
		}
		if !entryInfo.Mode().IsRegular() {
			continue
		}
		destination := filepath.Join(s.sessionDir(id), entry.Name())
		if _, statErr := os.Stat(destination); statErr == nil {
			continue
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return fmt.Errorf("inspect canonical attachment %q: %w", entry.Name(), statErr)
		}
		file, openErr := root.Open(filepath.Join(filepath.FromSlash(WorkspaceDir), entry.Name()))
		if openErr != nil {
			return fmt.Errorf("open workspace attachment %q: %w", entry.Name(), openErr)
		}
		copyErr := writeReaderAtomic(s.sessionDir(id), entry.Name(), file)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("import workspace attachment %q: %w", entry.Name(), copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close workspace attachment %q: %w", entry.Name(), closeErr)
		}
	}
	return nil
}

// MaterializeWorkspace projects every canonical attachment into a restored
// worktree before its controller is relaunched.
func (s *Store) MaterializeWorkspace(id domain.SessionID, workspacePath string) error {
	if s.root == "" {
		return nil
	}
	if err := validateSessionID(id); err != nil {
		return err
	}
	available, err := s.rootAvailable()
	if err != nil {
		return err
	}
	if !available {
		return nil
	}
	entries, err := os.ReadDir(s.sessionDir(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("list canonical attachments: %w", err)
	}
	root, err := os.OpenRoot(s.sessionDir(id))
	if err != nil {
		return fmt.Errorf("open canonical attachment root: %w", err)
	}
	defer func() { _ = root.Close() }()

	for _, entry := range entries {
		if temporaryName(entry.Name()) || entry.Type()&os.ModeSymlink != 0 || validateName(entry.Name()) != nil {
			continue
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return fmt.Errorf("inspect canonical attachment %q: %w", entry.Name(), infoErr)
		}
		if !entryInfo.Mode().IsRegular() {
			continue
		}
		file, openErr := root.Open(entry.Name())
		if openErr != nil {
			return fmt.Errorf("open canonical attachment %q: %w", entry.Name(), openErr)
		}
		copyErr := writeReaderAtomic(filepath.Join(workspacePath, filepath.FromSlash(WorkspaceDir)), entry.Name(), file)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("materialize attachment %q: %w", entry.Name(), copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close canonical attachment %q: %w", entry.Name(), closeErr)
		}
	}
	return nil
}

// Open opens a regular canonical attachment for HTTP serving.
func (s *Store) Open(id domain.SessionID, name string) (*os.File, fs.FileInfo, error) {
	if s.root == "" {
		return nil, nil, fs.ErrNotExist
	}
	if err := validateSessionID(id); err != nil {
		return nil, nil, fs.ErrNotExist
	}
	if err := validateName(name); err != nil {
		return nil, nil, fs.ErrNotExist
	}
	available, err := s.rootAvailable()
	if err != nil || !available {
		return nil, nil, fs.ErrNotExist
	}
	root, err := os.OpenRoot(s.sessionDir(id))
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = root.Close() }()
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fs.ErrNotExist
	}
	return file, info, nil
}

// RemoveSession removes canonical files only when the owning session row was
// itself permanently deleted. Kill and cleanup intentionally do not call it.
func (s *Store) RemoveSession(id domain.SessionID) error {
	if s.root == "" {
		return nil
	}
	if err := validateSessionID(id); err != nil {
		return err
	}
	available, err := s.rootAvailable()
	if err != nil {
		return err
	}
	if !available {
		return nil
	}
	return os.RemoveAll(s.sessionDir(id))
}

// NameFromWorkspacePath recognizes a direct file in the attachment projection.
// Nested paths and traversal are deliberately rejected.
func NameFromWorkspacePath(raw string) (string, bool) {
	raw = strings.ReplaceAll(raw, `\`, "/")
	raw = strings.TrimPrefix(raw, "/")
	parts := strings.Split(raw, "/")
	if len(parts) != 3 || parts[0] != ".ao" || parts[1] != "attachments" {
		return "", false
	}
	if validateName(parts[2]) != nil {
		return "", false
	}
	return parts[2], true
}

func (s *Store) sessionDir(id domain.SessionID) string {
	return filepath.Join(s.root, string(id))
}

func (s *Store) rootAvailable() (bool, error) {
	info, err := os.Stat(s.root)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, nil
	}
	return true, nil
}

func validateSessionID(id domain.SessionID) error {
	raw := string(id)
	if raw == "" || raw == "." || raw == ".." || strings.ContainsAny(raw, `/\`) || strings.ContainsRune(raw, 0) {
		return fmt.Errorf("invalid attachment session id %q", raw)
	}
	return nil
}

func validateName(name string) error {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, 0) {
		return fmt.Errorf("invalid attachment name %q", name)
	}
	return nil
}

func temporaryName(name string) bool {
	return strings.HasPrefix(name, ".attachment-")
}

func writeFileAtomic(dir, name string, data []byte) error {
	return writeReaderAtomic(dir, name, bytes.NewReader(data))
}

func writeReaderAtomic(dir, name string, source io.Reader) (retErr error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".attachment-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := io.Copy(tmp, source); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	target := filepath.Join(dir, name)
	if err := os.Rename(tmpName, target); err != nil {
		// Windows does not replace an existing target with Rename. Restored
		// worktrees may already contain the projection, so retry after removal.
		if removeErr := os.Remove(target); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			return err
		}
		if retryErr := os.Rename(tmpName, target); retryErr != nil {
			return retryErr
		}
	}
	return nil
}
