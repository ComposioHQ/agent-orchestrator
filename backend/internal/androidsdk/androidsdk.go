package androidsdk

import (
	"fmt"
	"path/filepath"
)

// Dir returns the root directory for all Android SDK content under toolsDir
// (config.Config.ToolsDir). A dedicated subdirectory, rather than toolsDir
// itself, leaves room for future sibling tool directories (e.g. an iOS
// toolchain cache) without collision.
func Dir(toolsDir string) string {
	return filepath.Join(toolsDir, "android")
}

// PlatformToolsDir is where the unzipped platform-tools package (adb, etc.)
// lives.
func PlatformToolsDir(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), "platform-tools")
}

// EmulatorDir is where the unzipped emulator package lives.
func EmulatorDir(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), "emulator")
}

// SystemImageDir is where the unzipped system image for the given API level,
// tag (e.g. "google_apis"), and ABI (e.g. "x86_64") lives.
func SystemImageDir(toolsDir string, apiLevel int, tag, abi string) string {
	return filepath.Join(Dir(toolsDir), "system-images", fmt.Sprintf("android-%d", apiLevel), tag, abi)
}

// LicensesDir is where accepted-license hash files are written, matching the
// layout AGP's own license check expects under a normal ANDROID_HOME.
func LicensesDir(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), "licenses")
}

// AVDHomeDir is where AO's managed AVD lives (ANDROID_AVD_HOME).
func AVDHomeDir(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), "avd")
}

// ManifestPath is the idempotency record: which component versions are
// currently installed. Its presence (with matching versions) is what lets
// Install skip re-downloading already-installed components.
func ManifestPath(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), ".ao-manifest.json")
}
