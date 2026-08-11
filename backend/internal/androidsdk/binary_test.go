package androidsdk

import (
	"runtime"
	"testing"
)

func TestAdbBinaryNameMatchesHostOS(t *testing.T) {
	got := AdbBinaryName()
	if runtime.GOOS == "windows" {
		if got != "adb.exe" {
			t.Errorf("AdbBinaryName() = %q, want adb.exe on windows", got)
		}
	} else if got != "adb" {
		t.Errorf("AdbBinaryName() = %q, want adb on %s", got, runtime.GOOS)
	}
}
