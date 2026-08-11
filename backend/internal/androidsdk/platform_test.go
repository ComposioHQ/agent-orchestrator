package androidsdk

import "testing"

func TestDetectPlatform(t *testing.T) {
	tests := []struct {
		name         string
		goos, goarch string
		want         Platform
	}{
		{
			name: "windows amd64",
			goos: "windows", goarch: "amd64",
			want: Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"},
		},
		{
			name: "macos amd64",
			goos: "darwin", goarch: "amd64",
			want: Platform{RepoOS: "macosx", RepoArch: "x64", SysImgABI: "x86_64"},
		},
		{
			name: "macos arm64",
			goos: "darwin", goarch: "arm64",
			want: Platform{RepoOS: "macosx", RepoArch: "aarch64", SysImgABI: "arm64-v8a"},
		},
		{
			name: "linux amd64",
			goos: "linux", goarch: "amd64",
			want: Platform{RepoOS: "linux", RepoArch: "x64", SysImgABI: "x86_64"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DetectPlatform(tt.goos, tt.goarch)
			if err != nil {
				t.Fatalf("DetectPlatform(%q, %q): %v", tt.goos, tt.goarch, err)
			}
			if got != tt.want {
				t.Errorf("DetectPlatform(%q, %q) = %+v, want %+v", tt.goos, tt.goarch, got, tt.want)
			}
		})
	}
}

func TestDetectPlatformUnsupported(t *testing.T) {
	tests := []struct {
		name         string
		goos, goarch string
	}{
		{name: "windows arm64: no desktop Android emulator build ships for it", goos: "windows", goarch: "arm64"},
		{name: "linux arm64: no desktop Android emulator build ships for it", goos: "linux", goarch: "arm64"},
		{name: "unknown os", goos: "plan9", goarch: "amd64"},
		{name: "unknown arch", goos: "linux", goarch: "riscv64"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DetectPlatform(tt.goos, tt.goarch)
			if err == nil {
				t.Fatalf("DetectPlatform(%q, %q) = nil error, want an error", tt.goos, tt.goarch)
			}
		})
	}
}
