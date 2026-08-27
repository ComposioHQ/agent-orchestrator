//go:build windows

package conpty

import (
	"testing"

	"golang.org/x/sys/windows"
)

// TestPtyHostSysProcAttr guards the ConPTY Ctrl+C delivery path: pty-host calls
// CreatePseudoConsole, and conhost only delivers synthesized CTRL_C_EVENTs to
// processes in its own console process group, so the host must stay detached
// (DETACHED_PROCESS) but must NOT be isolated into a new process group.
func TestPtyHostSysProcAttr(t *testing.T) {
	attr := ptyHostSysProcAttr()
	if attr.CreationFlags&windows.CREATE_NEW_PROCESS_GROUP != 0 {
		t.Fatalf("CreationFlags = %#x, must not include CREATE_NEW_PROCESS_GROUP (breaks ConPTY Ctrl+C delivery)", attr.CreationFlags)
	}
	if attr.CreationFlags&windows.DETACHED_PROCESS == 0 {
		t.Fatalf("CreationFlags = %#x, want DETACHED_PROCESS set", attr.CreationFlags)
	}
}
