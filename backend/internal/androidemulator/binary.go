package androidemulator

import "runtime"

// EmulatorBinaryName is the emulator executable's filename within the
// downloaded emulator package directory, which differs by host OS
// (confirmed against the real downloaded package during the A0 spike:
// emulator.exe on Windows, emulator with no extension elsewhere).
func EmulatorBinaryName() string {
	if runtime.GOOS == "windows" {
		return "emulator.exe"
	}
	return "emulator"
}
