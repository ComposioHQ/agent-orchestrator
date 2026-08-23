// Package sandboxruntime implements the isolated ao-sandbox process. It owns
// only compute-local runtime, observation, and transport behavior; durable AO
// product state remains in the control plane.
package sandboxruntime

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
)

const (
	// CapabilityPath is the only supported launch-capability location. The
	// provider mounts the raw bearer bytes here; configuration and placement
	// metadata travel separately.
	CapabilityPath = "/run/ao/capability"

	maxCapabilityBytes = 64 * 1024
)

var (
	ErrCapabilityInsecure = errors.New("sandbox capability file is insecure")
	ErrCapabilityInvalid  = errors.New("sandbox capability is invalid")
)

// WithCapability reads the fixed launch-capability file, lets fn use its raw
// mutable bytes, and zeroes the buffer before returning. Callers must not retain
// the slice. In particular, they should create an Authorization header only
// for the duration of one request and remove it immediately afterwards.
func WithCapability(expectedUID uint32, fn func([]byte) error) error {
	return withCapabilityAt(CapabilityPath, expectedUID, fn)
}

func withCapabilityAt(path string, expectedUID uint32, fn func([]byte) error) error {
	if fn == nil {
		return fmt.Errorf("%w: use callback is required", ErrCapabilityInvalid)
	}

	file, info, uid, err := openCapability(path)
	if err != nil {
		return err
	}
	defer file.Close()

	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: must be a regular file", ErrCapabilityInsecure)
	}
	if info.Mode().Perm() != 0o600 {
		return fmt.Errorf("%w: mode must be 0600", ErrCapabilityInsecure)
	}
	if uid != expectedUID {
		return fmt.Errorf("%w: owner does not match runtime uid", ErrCapabilityInsecure)
	}

	raw, err := io.ReadAll(io.LimitReader(file, maxCapabilityBytes+1))
	if err != nil {
		return fmt.Errorf("read sandbox capability: %w", err)
	}
	defer zeroBytes(raw)

	if err := validateRawCapability(raw); err != nil {
		return err
	}
	return fn(raw)
}

func validateRawCapability(raw []byte) error {
	if len(raw) == 0 {
		return fmt.Errorf("%w: empty", ErrCapabilityInvalid)
	}
	if len(raw) > maxCapabilityBytes {
		return fmt.Errorf("%w: exceeds size limit", ErrCapabilityInvalid)
	}

	// A capability is the bearer itself, not a serialized launch document. A
	// leading JSON container marker catches the rejected capability.json shape
	// without decoding or ever rendering secret material into an error.
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		return fmt.Errorf("%w: must contain raw bearer bytes, not JSON", ErrCapabilityInvalid)
	}

	// The bearer is placed in an HTTP field value. Refuse bytes that could
	// terminate or inject a header; do not normalize or trim the credential.
	for _, b := range raw {
		if b < 0x20 || b == 0x7f {
			return fmt.Errorf("%w: contains a control byte", ErrCapabilityInvalid)
		}
	}
	return nil
}

func zeroBytes(raw []byte) {
	for i := range raw {
		raw[i] = 0
	}
	// Keep the buffer live through the overwrite so the compiler cannot prove
	// the writes irrelevant and elide them.
	runtime.KeepAlive(raw)
}

// openCapability opens path without following a final symlink, returning the
// metadata from the opened descriptor so path replacement cannot bypass the
// ownership and mode checks.
func openCapability(path string) (*os.File, os.FileInfo, uint32, error) {
	return openCapabilityFile(path)
}
