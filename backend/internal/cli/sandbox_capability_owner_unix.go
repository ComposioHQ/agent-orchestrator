//go:build !windows

package cli

import (
	"errors"
	"os"
	"syscall"
)

func capabilityOwnedByProcess(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return errors.New("sandbox capability file must be owned by the current process user")
	}
	return nil
}
