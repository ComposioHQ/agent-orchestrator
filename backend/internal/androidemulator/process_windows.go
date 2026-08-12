//go:build windows

package androidemulator

import (
	"os/exec"
	"strconv"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// configureProcAttr is a no-op on Windows: killTree below uses taskkill /T,
// which walks the OS-tracked process tree directly and needs no special
// SysProcAttr set at spawn time (unlike the Unix process-group approach).
func configureProcAttr(_ *exec.Cmd) {}

// killTree terminates pid and every descendant process. The Android emulator
// is a launcher whose actual VM backend (qemu-system-x86_64-headless.exe)
// runs as a separate child process; killing only the launcher leaves that
// child running and still holding the AVD's lock files, so the next boot
// fails with "Running multiple emulators with the same AVD". taskkill /T
// walks the OS-tracked parent-child tree from pid, matching the same
// mechanism previewserver already uses for supervised dev-server processes.
func killTree(pid int) error {
	return aoprocess.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}
