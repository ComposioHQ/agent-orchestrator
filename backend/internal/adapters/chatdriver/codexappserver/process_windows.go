//go:build windows

package codexappserver

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// configureAppServerProcess keeps AO's stdio-only Codex helper from allocating
// or activating a console window. The process remains attached to, and owned
// by, the conversation that started it; these flags do not detach it.
func configureAppServerProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW,
		HideWindow:    true,
	}
}
