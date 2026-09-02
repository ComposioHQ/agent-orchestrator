//go:build !windows

package conpty

import (
	"errors"
	"syscall"
)

// pidAlive probes PID liveness via signal 0. nil and EPERM both mean alive
// (process exists but may not be signallable). ESRCH means dead.
// Mirrors ptyregistry.defaultPidAlive (same signal-0 pattern).
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
