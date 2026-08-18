package androidemulator

import (
	"runtime"
	"testing"
)

func TestEmulatorBinaryNameMatchesHostOS(t *testing.T) {
	got := EmulatorBinaryName()
	if runtime.GOOS == "windows" {
		if got != "emulator.exe" {
			t.Errorf("EmulatorBinaryName() = %q, want emulator.exe on windows", got)
		}
	} else if got != "emulator" {
		t.Errorf("EmulatorBinaryName() = %q, want emulator on %s", got, runtime.GOOS)
	}
}
