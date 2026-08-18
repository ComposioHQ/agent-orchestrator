package androidsdk

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// DetectedSystemImage describes one system image found under a detected SDK
// root, in the same vocabulary AO's own managed installs use.
type DetectedSystemImage struct {
	APILevel int
	Tag      string
	ABI      string
	// RelPath is the system image's location relative to the SDK root
	// (e.g. "system-images/android-34/google_apis/x86_64/"), the exact
	// format WriteAVDConfig's sysImageRelPath expects -- identical whether
	// the root is AO-managed or a real Android Studio install, since both
	// follow the same standard SDK repository layout.
	RelPath string
}

// DetectedSDK is an existing, externally-managed Android SDK installation
// (e.g. one installed by Android Studio) that has everything AO's emulator
// needs: adb, the emulator binary, and at least one system image matching
// the host's ABI.
type DetectedSDK struct {
	Root        string
	SystemImage DetectedSystemImage
}

// tagPreference ranks system-image tags when more than one is available at
// the same (highest) API level, closest match first to AO's own default
// choice of "google_apis". A tag not in this list still counts (some
// candidate is better than none) but ranks last.
var tagPreference = []string{"google_apis_playstore", "google_apis", "default"}

// emulatorBinaryName mirrors androidemulator.EmulatorBinaryName()'s two-line
// body rather than importing that package: androidsdk is the lower-level,
// dependency-free package (zero AO-internal imports today, in either
// direction between androidsdk and androidemulator), and importing the
// higher-level androidemulator package here would invert that relationship
// for the sake of one OS-suffix check.
func emulatorBinaryName() string {
	if runtime.GOOS == "windows" {
		return "emulator.exe"
	}
	return "emulator"
}

// DetectExisting scans candidateRoots in order and returns the first that
// looks like a usable Android SDK for abi (AO's own SysImgABI vocabulary,
// e.g. "x86_64"): platform-tools/adb, emulator/emulator, and at least one
// system image matching abi.
func DetectExisting(candidateRoots []string, abi string) (DetectedSDK, bool) {
	for _, root := range candidateRoots {
		if root == "" {
			continue
		}
		if img, ok := detectRoot(root, abi); ok {
			return DetectedSDK{Root: root, SystemImage: img}, true
		}
	}
	return DetectedSDK{}, false
}

func detectRoot(root, abi string) (DetectedSystemImage, bool) {
	if !isRegularFile(filepath.Join(PlatformToolsDirIn(root), AdbBinaryName())) {
		return DetectedSystemImage{}, false
	}
	if !isRegularFile(filepath.Join(EmulatorDirIn(root), emulatorBinaryName())) {
		return DetectedSystemImage{}, false
	}
	return bestSystemImage(root, abi)
}

// bestSystemImage scans root/system-images/android-<N>/<tag>/<abi>/ for the
// highest API level matching abi, tie-broken by tagPreference.
func bestSystemImage(root, abi string) (DetectedSystemImage, bool) {
	apiDirs, err := os.ReadDir(filepath.Join(root, "system-images"))
	if err != nil {
		return DetectedSystemImage{}, false
	}

	var best DetectedSystemImage
	var bestRank int
	found := false

	for _, apiEntry := range apiDirs {
		if !apiEntry.IsDir() {
			continue
		}
		apiLevel, ok := parseAPILevelDir(apiEntry.Name())
		if !ok {
			continue
		}
		tagDirs, err := os.ReadDir(filepath.Join(root, "system-images", apiEntry.Name()))
		if err != nil {
			continue
		}
		for _, tagEntry := range tagDirs {
			if !tagEntry.IsDir() {
				continue
			}
			tag := tagEntry.Name()
			abiDir := filepath.Join(root, "system-images", apiEntry.Name(), tag, abi)
			if _, ok := systemImageFile(abiDir); !ok {
				continue
			}
			rank := tagRank(tag)
			better := !found || apiLevel > best.APILevel || (apiLevel == best.APILevel && rank < bestRank)
			if better {
				best = DetectedSystemImage{
					APILevel: apiLevel,
					Tag:      tag,
					ABI:      abi,
					RelPath:  fmt.Sprintf("system-images/android-%d/%s/%s/", apiLevel, tag, abi),
				}
				bestRank = rank
				found = true
			}
		}
	}
	return best, found
}

func tagRank(tag string) int {
	for i, t := range tagPreference {
		if t == tag {
			return i
		}
	}
	return len(tagPreference)
}

func parseAPILevelDir(name string) (int, bool) {
	const prefix = "android-"
	if !strings.HasPrefix(name, prefix) {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(name, prefix))
	if err != nil {
		return 0, false
	}
	return n, true
}

// systemImageFile stats the system.img file directly inside dir, the
// standard SDK repository layout's marker that a system image is actually
// present there (not just an empty directory). Shared between DetectExisting
// and the external-marker revalidation in installedinfo.go so the two can't
// drift and disagree about what counts as "present."
func systemImageFile(dir string) (os.FileInfo, bool) {
	info, err := os.Stat(filepath.Join(dir, "system.img"))
	if err != nil || info.IsDir() {
		return nil, false
	}
	return info, true
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return true
}

// DefaultCandidateRoots returns, in priority order, the places an existing
// Android SDK is commonly found: ANDROID_HOME, then ANDROID_SDK_ROOT (if
// different), then the per-OS default Android Studio install location.
// goos/homeDir/localAppData/androidHome/androidSDKRoot are injected rather
// than read from os.Getenv/runtime.GOOS here, so this stays testable with
// plain values -- the caller (daemon wiring) is responsible for supplying
// the real ones.
//
// An env-derived base that's unset (empty string) simply skips the
// candidate it would have produced, rather than joining it into a garbage
// relative path.
func DefaultCandidateRoots(goos, homeDir, localAppData, androidHome, androidSDKRoot string) []string {
	var roots []string
	seen := make(map[string]bool)
	add := func(root string) {
		if root == "" || seen[root] {
			return
		}
		seen[root] = true
		roots = append(roots, root)
	}

	add(androidHome)
	add(androidSDKRoot)

	switch goos {
	case "windows":
		if localAppData != "" {
			add(filepath.Join(localAppData, "Android", "Sdk"))
		}
	case "darwin":
		if homeDir != "" {
			add(filepath.Join(homeDir, "Library", "Android", "sdk"))
		}
	case "linux":
		if homeDir != "" {
			add(filepath.Join(homeDir, "Android", "Sdk"))
		}
	}

	return roots
}
