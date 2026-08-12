//go:build !windows

package androidemulator

import (
	"os/exec"
	"syscall"
)

// configureProcAttr puts the spawned process in its own process group so
// killTree can terminate it and every descendant with one call. Without this,
// a negative-PID kill would target the daemon's own process group instead.
func configureProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree terminates pid and every descendant process by signaling the
// whole process group at once (negative pid). See process_windows.go for why
// this matters: the emulator launcher's actual VM backend runs as a separate
// child process that a plain single-PID kill would leave running.
func killTree(pid int) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
