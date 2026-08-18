package androidsdk

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeFakeSDKBinaries creates a minimal, valid-looking adb + emulator binary
// pair under root, matching the real SDK's platform-tools/emulator layout.
func writeFakeSDKBinaries(t *testing.T, root string) {
	t.Helper()
	mustWriteFile(t, filepath.Join(PlatformToolsDirIn(root), AdbBinaryName()), "adb")
	mustWriteFile(t, filepath.Join(EmulatorDirIn(root), emulatorBinaryName()), "emulator")
}

// writeFakeSystemImage creates a system.img at the standard relative layout
// (system-images/android-<N>/<tag>/<abi>/system.img) under root.
func writeFakeSystemImage(t *testing.T, root string, apiLevel int, tag, abi string) {
	t.Helper()
	dir := filepath.Join(root, "system-images", fmt.Sprintf("android-%d", apiLevel), tag, abi)
	mustWriteFile(t, filepath.Join(dir, "system.img"), "system image bytes")
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDetectExistingFindsValidSDK(t *testing.T) {
	root := t.TempDir()
	writeFakeSDKBinaries(t, root)
	writeFakeSystemImage(t, root, 34, "google_apis", "x86_64")

	got, ok := DetectExisting([]string{root}, "x86_64")
	if !ok {
		t.Fatal("DetectExisting: ok = false, want true")
	}
	want := DetectedSDK{
		Root: root,
		SystemImage: DetectedSystemImage{
			APILevel: 34,
			Tag:      "google_apis",
			ABI:      "x86_64",
			RelPath:  "system-images/android-34/google_apis/x86_64/",
		},
	}
	if got != want {
		t.Errorf("DetectExisting = %+v, want %+v", got, want)
	}
}

func TestDetectExistingRejectsMissingAdb(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(EmulatorDirIn(root), emulatorBinaryName()), "emulator")
	writeFakeSystemImage(t, root, 34, "google_apis", "x86_64")

	if _, ok := DetectExisting([]string{root}, "x86_64"); ok {
		t.Error("DetectExisting: ok = true, want false when adb is missing")
	}
}

func TestDetectExistingRejectsMissingEmulatorBinary(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(PlatformToolsDirIn(root), AdbBinaryName()), "adb")
	writeFakeSystemImage(t, root, 34, "google_apis", "x86_64")

	if _, ok := DetectExisting([]string{root}, "x86_64"); ok {
		t.Error("DetectExisting: ok = true, want false when the emulator binary is missing")
	}
}

func TestDetectExistingRejectsNoSystemImages(t *testing.T) {
	root := t.TempDir()
	writeFakeSDKBinaries(t, root)

	if _, ok := DetectExisting([]string{root}, "x86_64"); ok {
		t.Error("DetectExisting: ok = true, want false when no system images are present")
	}
}

func TestDetectExistingRejectsABIMismatch(t *testing.T) {
	root := t.TempDir()
	writeFakeSDKBinaries(t, root)
	writeFakeSystemImage(t, root, 34, "google_apis", "arm64-v8a")

	if _, ok := DetectExisting([]string{root}, "x86_64"); ok {
		t.Error("DetectExisting: ok = true, want false when the only system image doesn't match the host ABI")
	}
}

func TestDetectExistingPicksHighestAPILevel(t *testing.T) {
	root := t.TempDir()
	writeFakeSDKBinaries(t, root)
	writeFakeSystemImage(t, root, 30, "google_apis", "x86_64")
	writeFakeSystemImage(t, root, 34, "google_apis", "x86_64")

	got, ok := DetectExisting([]string{root}, "x86_64")
	if !ok {
		t.Fatal("DetectExisting: ok = false, want true")
	}
	if got.SystemImage.APILevel != 34 {
		t.Errorf("APILevel = %d, want 34 (the highest available)", got.SystemImage.APILevel)
	}
}

func TestDetectExistingPrefersTagOnTie(t *testing.T) {
	root := t.TempDir()
	writeFakeSDKBinaries(t, root)
	writeFakeSystemImage(t, root, 34, "default", "x86_64")
	writeFakeSystemImage(t, root, 34, "google_apis", "x86_64")

	got, ok := DetectExisting([]string{root}, "x86_64")
	if !ok {
		t.Fatal("DetectExisting: ok = false, want true")
	}
	if got.SystemImage.Tag != "google_apis" {
		t.Errorf("Tag = %q, want %q (preferred over %q at the same API level)", got.SystemImage.Tag, "google_apis", "default")
	}
}

func TestDetectExistingTriesNextCandidateOnFailure(t *testing.T) {
	invalid := t.TempDir() // no binaries at all
	valid := t.TempDir()
	writeFakeSDKBinaries(t, valid)
	writeFakeSystemImage(t, valid, 34, "google_apis", "x86_64")

	got, ok := DetectExisting([]string{invalid, valid}, "x86_64")
	if !ok {
		t.Fatal("DetectExisting: ok = false, want true (second candidate is valid)")
	}
	if got.Root != valid {
		t.Errorf("Root = %q, want %q", got.Root, valid)
	}
}

func TestDetectExistingNoCandidates(t *testing.T) {
	if _, ok := DetectExisting(nil, "x86_64"); ok {
		t.Error("DetectExisting: ok = true, want false for an empty candidate list")
	}
}

func TestDefaultCandidateRoots(t *testing.T) {
	tests := []struct {
		name                                              string
		goos, homeDir, localAppData, androidHome, sdkRoot string
		want                                              []string
	}{
		{
			name: "windows: LOCALAPPDATA default included after env vars",
			goos: "windows", localAppData: `C:\Users\me\AppData\Local`,
			androidHome: `C:\android-home`, sdkRoot: `C:\android-sdk-root`,
			want: []string{`C:\android-home`, `C:\android-sdk-root`, filepath.Join(`C:\Users\me\AppData\Local`, "Android", "Sdk")},
		},
		{
			name: "darwin: Library/Android/sdk default",
			goos: "darwin", homeDir: "/Users/me",
			want: []string{filepath.Join("/Users/me", "Library", "Android", "sdk")},
		},
		{
			name: "linux: Android/Sdk default",
			goos: "linux", homeDir: "/home/me",
			want: []string{filepath.Join("/home/me", "Android", "Sdk")},
		},
		{
			name: "empty env-derived bases are skipped, not joined into garbage paths",
			goos: "windows", localAppData: "",
			want: nil,
		},
		{
			name: "ANDROID_SDK_ROOT deduplicated when identical to ANDROID_HOME",
			goos: "linux", homeDir: "/home/me",
			androidHome: "/opt/sdk", sdkRoot: "/opt/sdk",
			want: []string{"/opt/sdk", filepath.Join("/home/me", "Android", "Sdk")},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DefaultCandidateRoots(tt.goos, tt.homeDir, tt.localAppData, tt.androidHome, tt.sdkRoot)
			if len(got) != len(tt.want) {
				t.Fatalf("DefaultCandidateRoots = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("DefaultCandidateRoots[%d] = %q, want %q (full: got=%v want=%v)", i, got[i], tt.want[i], got, tt.want)
				}
			}
		})
	}
}
