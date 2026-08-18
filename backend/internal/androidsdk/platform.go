// Package androidsdk lazily downloads and verifies the Android SDK components
// AO needs to run an embedded emulator (platform-tools, emulator, one system
// image) directly from Google's public repository manifests. It does not
// shell out to sdkmanager/avdmanager: those require a JRE, which AO does not
// bundle.
package androidsdk

import (
	"fmt"
	"runtime"
)

// Platform identifies a host OS+arch in the vocabulary Google's Android SDK
// repository manifests use, which does not match Go's runtime.GOOS/GOARCH
// spelling.
type Platform struct {
	// RepoOS is the manifest's <host-os> value: "windows", "macosx", "linux".
	RepoOS string
	// RepoArch is the manifest's <host-arch> value: "x64", "aarch64".
	RepoArch string
	// SysImgABI is the system-image ABI tag used in system-image package
	// paths, e.g. "system-images;android-34;google_apis;x86_64".
	SysImgABI string
}

// HostPlatform detects the current process's host platform.
func HostPlatform() (Platform, error) {
	return DetectPlatform(runtime.GOOS, runtime.GOARCH)
}

// DetectPlatform maps a Go GOOS/GOARCH pair to the vocabulary used by
// Android's SDK repository manifests. It returns an error for combinations
// Android's SDK does not ship a desktop emulator build for (e.g. windows/arm64,
// linux/arm64 — verified against the real repository manifest during the A0
// spike: only windows/x64, linux/x64, macosx/x64, and macosx/aarch64 emulator
// archives exist).
func DetectPlatform(goos, goarch string) (Platform, error) {
	var repoOS string
	switch goos {
	case "windows":
		repoOS = "windows"
	case "darwin":
		repoOS = "macosx"
	case "linux":
		repoOS = "linux"
	default:
		return Platform{}, fmt.Errorf("androidsdk: unsupported host OS %q", goos)
	}

	var repoArch, sysImgABI string
	switch goarch {
	case "amd64":
		repoArch, sysImgABI = "x64", "x86_64"
	case "arm64":
		repoArch, sysImgABI = "aarch64", "arm64-v8a"
	default:
		return Platform{}, fmt.Errorf("androidsdk: unsupported host arch %q", goarch)
	}

	if repoArch == "aarch64" && repoOS != "macosx" {
		return Platform{}, fmt.Errorf("androidsdk: no Android emulator build ships for %s/%s", goos, goarch)
	}

	return Platform{RepoOS: repoOS, RepoArch: repoArch, SysImgABI: sysImgABI}, nil
}
