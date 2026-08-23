//go:build windows

package cli

import (
	"errors"
	"os"
)

func capabilityOwnedByProcess(os.FileInfo) error {
	return errors.New("sandbox capability ownership cannot be verified on Windows")
}
