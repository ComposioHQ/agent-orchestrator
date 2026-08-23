// Package secretfile provides a neutral owner-only file delivery boundary for
// secret bytes. It has no dependency on sandbox, provider, or daemon code.
package secretfile

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Sink atomically delivers secret bytes and remembers them for bounded purge.
type Sink struct {
	root  string
	mu    sync.Mutex
	paths map[string]struct{}
}

// NewSink prepares an owner-only directory for ephemeral credentials.
func NewSink(root string) (*Sink, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("secret file root must be an absolute path")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create secret file root: %w", err)
	}
	// #nosec G302 -- directories require owner execute permission to be usable.
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("secure secret file root: %w", err)
	}
	return &Sink{root: root, paths: make(map[string]struct{})}, nil
}

// Deliver atomically writes data to name. Only mode 0600 is accepted.
func (s *Sink) Deliver(name string, data []byte, mode fs.FileMode) (string, error) {
	if mode.Perm() != 0o600 {
		return "", errors.New("secret file mode must be 0600")
	}
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return "", errors.New("secret file name must be one path component")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(s.root, name)
	tmp, err := os.CreateTemp(s.root, ".deliver-*")
	if err != nil {
		return "", fmt.Errorf("create secret file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("secure secret file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("write secret file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("sync secret file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close secret file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return "", fmt.Errorf("publish secret file: %w", err)
	}
	s.paths[path] = struct{}{}
	return path, nil
}

// Purge removes every file delivered by this sink. It is idempotent and
// attempts all removals before returning the first error.
func (s *Sink) Purge() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	for path := range s.paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) && first == nil {
			first = fmt.Errorf("purge secret file: %w", err)
		}
		delete(s.paths, path)
	}
	return first
}
