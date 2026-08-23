// Package sandboxruntime implements the disposable ao-sandbox compute process.
// It deliberately has no daemon, durable store, relay, or provider adapter.
package sandboxruntime

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// FileSecret delivers secret bytes through owner-only files. Secret values are
// never accepted through argv or environment variables.
type FileSecret struct {
	root  string
	mu    sync.Mutex
	paths map[string]struct{}
}

// NewFileSecret prepares an owner-only directory for ephemeral credentials.
func NewFileSecret(root string) (*FileSecret, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("file secret root must be an absolute path")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create file secret root: %w", err)
	}
	// #nosec G302 -- directories require owner execute permission to be usable.
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("secure file secret root: %w", err)
	}
	return &FileSecret{root: root, paths: make(map[string]struct{})}, nil
}

// Deliver atomically writes data to name. Only mode 0600 is accepted; callers
// cannot accidentally broaden a credential after choosing this API.
func (s *FileSecret) Deliver(name string, data []byte, mode fs.FileMode) (string, error) {
	if mode.Perm() != 0o600 {
		return "", errors.New("file secret mode must be 0600")
	}
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return "", errors.New("file secret name must be one path component")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(s.root, name)
	tmp, err := os.CreateTemp(s.root, ".deliver-*")
	if err != nil {
		return "", fmt.Errorf("create file secret: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("secure file secret: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("write file secret: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("sync file secret: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close file secret: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return "", fmt.Errorf("publish file secret: %w", err)
	}
	s.paths[path] = struct{}{}
	return path, nil
}

// Purge removes every file delivered by this instance. It is idempotent and
// attempts all removals before returning the first error.
func (s *FileSecret) Purge() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	for path := range s.paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) && first == nil {
			first = fmt.Errorf("purge file secret: %w", err)
		}
		delete(s.paths, path)
	}
	return first
}
