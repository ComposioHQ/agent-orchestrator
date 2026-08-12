//go:build windows

package codexappserver

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestConfigureAppServerProcessHidesConsoleWindow(t *testing.T) {
	cmd := exec.Command("codex", "app-server")
	configureAppServerProcess(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr = nil, want hidden Windows process attributes")
	}
	if got := cmd.SysProcAttr.CreationFlags; got&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("CreationFlags = %#x, want CREATE_NO_WINDOW", got)
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("HideWindow = false, want true")
	}
}
