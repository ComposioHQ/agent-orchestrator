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

// afterSpawn needs nothing extra on Unix: the process group set up by
// configureProcAttr already covers the case a plain PID-based kill wouldn't
// (see killTree) -- including a launcher that exits on its own, since a
// process group persists as long as any member of it is still alive, not
// just its original leader.
func afterSpawn(_ *exec.Cmd) (any, error) {
	return nil, nil
}

// killTree terminates pid and every descendant process by signaling the
// whole process group at once (negative pid). See process_windows.go for why
// this matters: the emulator launcher's actual VM backend runs as a separate
// child process that a plain single-PID kill would leave running.
func killTree(pid int, _ any) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
