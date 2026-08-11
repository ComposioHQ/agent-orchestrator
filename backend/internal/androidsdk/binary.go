package androidsdk

import "runtime"

// AdbBinaryName is the adb executable's filename within the downloaded
// platform-tools package directory, which differs by host OS.
func AdbBinaryName() string {
	if runtime.GOOS == "windows" {
		return "adb.exe"
	}
	return "adb"
}
