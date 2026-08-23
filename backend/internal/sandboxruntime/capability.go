package sandboxruntime

import (
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	// DefaultCapabilityPath is the fixed launch capability location.
	DefaultCapabilityPath = "/run/ao/capability"
	maxCapabilityBytes    = 4 << 10
)

// CapabilityReader supplies the sandbox capability for one outbound request.
// Implementations must not cache the value so rotation takes effect immediately.
type CapabilityReader interface {
	ReadCapability() ([]byte, error)
}

// FileCapability reads a raw opaque capability from an owner-only regular file.
type FileCapability struct {
	Path string
}

// ReadCapability validates and reads the capability afresh for each redemption.
func (f FileCapability) ReadCapability() ([]byte, error) {
	if f.Path == "" {
		return nil, errors.New("capability path is required")
	}
	info, err := os.Lstat(f.Path)
	if err != nil {
		return nil, fmt.Errorf("stat capability: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("capability must be a regular file")
	}
	if info.Mode().Perm() != 0o600 {
		return nil, errors.New("capability file mode must be 0600")
	}
	if info.Size() < 1 || info.Size() > maxCapabilityBytes {
		return nil, errors.New("capability must contain 1 to 4096 bytes")
	}
	file, err := os.Open(f.Path)
	if err != nil {
		return nil, fmt.Errorf("open capability: %w", err)
	}
	defer func() { _ = file.Close() }()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect open capability: %w", err)
	}
	if !openedInfo.Mode().IsRegular() || openedInfo.Mode().Perm() != 0o600 || !os.SameFile(info, openedInfo) {
		return nil, errors.New("capability changed or is not an owner-only regular file")
	}
	if openedInfo.Size() < 1 || openedInfo.Size() > maxCapabilityBytes {
		return nil, errors.New("capability must contain 1 to 4096 bytes")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxCapabilityBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read capability: %w", err)
	}
	if len(raw) < 1 || len(raw) > maxCapabilityBytes {
		return nil, errors.New("capability must contain 1 to 4096 bytes")
	}
	for _, b := range raw {
		if b == '\r' || b == '\n' || b == 0 {
			return nil, errors.New("capability contains invalid header bytes")
		}
	}
	return raw, nil
}
