//go:build !windows

package androidemulator

import "syscall"

// processAlive reports whether pid still identifies a live process. Signal 0
// sends no actual signal -- the kernel just validates the target exists and
// is reachable, the standard Unix existence-check idiom.
func processAlive(pid int) bool {
	return syscall.Kill(pid, syscall.Signal(0)) == nil
}
