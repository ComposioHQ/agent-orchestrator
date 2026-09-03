//go:build windows

package nativeqwen

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestConfigureProcessCreatesCancellableProcessGroup(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit 0")
	configureProcess(cmd)
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.CreationFlags&windows.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatalf("creation flags = %#v, want CREATE_NEW_PROCESS_GROUP", cmd.SysProcAttr)
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("native review child window should be hidden")
	}
}
