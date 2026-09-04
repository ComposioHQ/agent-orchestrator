//go:build !windows

package nativeqwen

import (
	"os/exec"
	"testing"
)

func TestConfigureProcessCreatesCancellableProcessGroup(t *testing.T) {
	cmd := exec.Command("true")
	configureProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("process attributes = %#v, want Setpgid", cmd.SysProcAttr)
	}
}
