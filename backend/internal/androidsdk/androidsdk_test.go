package androidsdk

import (
	"path/filepath"
	"testing"
)

func TestDirLayout(t *testing.T) {
	toolsDir := filepath.Join("C:", "fake", "tools")

	tests := []struct {
		name string
		got  string
		want string
	}{
		{"Dir", Dir(toolsDir), filepath.Join(toolsDir, "android")},
		{"PlatformToolsDir", PlatformToolsDir(toolsDir), filepath.Join(toolsDir, "android", "platform-tools")},
		{"EmulatorDir", EmulatorDir(toolsDir), filepath.Join(toolsDir, "android", "emulator")},
		{"SystemImageDir", SystemImageDir(toolsDir, 34, "google_apis", "x86_64"), filepath.Join(toolsDir, "android", "system-images", "android-34", "google_apis", "x86_64")},
		{"LicensesDir", LicensesDir(toolsDir), filepath.Join(toolsDir, "android", "licenses")},
		{"AVDHomeDir", AVDHomeDir(toolsDir), filepath.Join(toolsDir, "android", "avd")},
		{"ManifestPath", ManifestPath(toolsDir), filepath.Join(toolsDir, "android", ".ao-manifest.json")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.want {
				t.Errorf("%s = %q, want %q", tt.name, tt.got, tt.want)
			}
		})
	}
}
