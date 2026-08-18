package androidemulator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultProfileMatchesA0SpikeVerifiedValues(t *testing.T) {
	// These exact values were booted, verified interactive, and measured
	// (~4.7fps screenshot polling) against a real emulator during the A0
	// spike. Changing them without re-verifying against a real boot is risky.
	p := DefaultProfile(34, "google_apis", "x86_64")
	if p.APILevel != 34 || p.Tag != "google_apis" || p.ABI != "x86_64" {
		t.Errorf("profile = %+v, want apiLevel=34 tag=google_apis abi=x86_64", p)
	}
	if p.Width != 1080 || p.Height != 2400 || p.Density != 420 {
		t.Errorf("profile dimensions = %dx%d@%d, want 1080x2400@420", p.Width, p.Height, p.Density)
	}
}

func TestWriteAVDConfigWritesPointerAndConfigFiles(t *testing.T) {
	avdHome := t.TempDir()
	profile := DefaultProfile(34, "google_apis", "x86_64")

	if err := WriteAVDConfig(avdHome, "ao-default", profile, "system-images/android-34/google_apis/x86_64/"); err != nil {
		t.Fatalf("WriteAVDConfig: %v", err)
	}

	pointerPath := filepath.Join(avdHome, "ao-default.ini")
	pointer, err := os.ReadFile(pointerPath)
	if err != nil {
		t.Fatalf("read pointer ini: %v", err)
	}
	wantAVDDir := filepath.Join(avdHome, "ao-default.avd")
	if !strings.Contains(string(pointer), "path="+wantAVDDir) {
		t.Errorf("pointer ini = %q, want it to contain path=%s (native OS path format)", pointer, wantAVDDir)
	}

	configPath := filepath.Join(avdHome, "ao-default.avd", "config.ini")
	config, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	configStr := string(config)
	for _, want := range []string{
		"image.sysdir.1=system-images/android-34/google_apis/x86_64/",
		"hw.lcd.width=1080",
		"hw.lcd.height=2400",
		"hw.lcd.density=420",
		"abi.type=x86_64",
		"tag.id=google_apis",
		"PlayStore.enabled=false",
	} {
		if !strings.Contains(configStr, want) {
			t.Errorf("config.ini missing %q\nfull content:\n%s", want, configStr)
		}
	}
}

// TestWriteAVDConfigEnablesPlayStoreForPlaystoreTag guards a real (if minor)
// gap: PlayStore.enabled was hardcoded to false even for the
// google_apis_playstore image tag, which does ship Play Store -- silently
// leaving it disabled defeats the point of choosing that tag over plain
// google_apis.
func TestWriteAVDConfigEnablesPlayStoreForPlaystoreTag(t *testing.T) {
	avdHome := t.TempDir()
	profile := DefaultProfile(34, "google_apis_playstore", "x86_64")

	if err := WriteAVDConfig(avdHome, "ao-default", profile, "system-images/android-34/google_apis_playstore/x86_64/"); err != nil {
		t.Fatalf("WriteAVDConfig: %v", err)
	}

	config, err := os.ReadFile(filepath.Join(avdHome, "ao-default.avd", "config.ini"))
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	if !strings.Contains(string(config), "PlayStore.enabled=true\n") {
		t.Errorf("config.ini missing %q for tag google_apis_playstore\nfull content:\n%s", "PlayStore.enabled=true", config)
	}
}

// TestWriteAVDConfigWritesCPUArchNotABIForArm64 guards against a real
// boot-blocking bug on Apple Silicon: config.ini's abi.type and hw.cpu.arch
// fields take different vocabularies (ABI vs CPU architecture) that happen
// to coincide on x86_64 ("x86_64" is valid for both) but diverge on ARM
// ("arm64-v8a" is a valid ABI but not a valid CPU arch -- the real emulator
// binary fails immediately with "FATAL | CPU Architecture 'arm64-v8a' is
// not supported by the QEMU2 emulator"). Every other test in this file uses
// the x86_64 profile, which cannot catch this class of bug.
func TestWriteAVDConfigWritesCPUArchNotABIForArm64(t *testing.T) {
	avdHome := t.TempDir()
	profile := DefaultProfile(34, "google_apis", "arm64-v8a")

	if err := WriteAVDConfig(avdHome, "ao-default", profile, "system-images/android-34/google_apis/arm64-v8a/"); err != nil {
		t.Fatalf("WriteAVDConfig: %v", err)
	}

	config, err := os.ReadFile(filepath.Join(avdHome, "ao-default.avd", "config.ini"))
	if err != nil {
		t.Fatalf("read config.ini: %v", err)
	}
	configStr := string(config)
	if !strings.Contains(configStr, "hw.cpu.arch=arm64\n") {
		t.Errorf("config.ini missing %q (want the CPU arch, not the ABI)\nfull content:\n%s", "hw.cpu.arch=arm64", configStr)
	}
	if !strings.Contains(configStr, "abi.type=arm64-v8a\n") {
		t.Errorf("config.ini missing %q (abi.type must stay the real ABI)\nfull content:\n%s", "abi.type=arm64-v8a", configStr)
	}
}

func TestCpuArchForABI(t *testing.T) {
	tests := []struct{ abi, want string }{
		{"arm64-v8a", "arm64"},
		{"armeabi-v7a", "arm"},
		{"armeabi", "arm"},
		{"x86_64", "x86_64"},
		{"x86", "x86"},
	}
	for _, tt := range tests {
		t.Run(tt.abi, func(t *testing.T) {
			if got := cpuArchForABI(tt.abi); got != tt.want {
				t.Errorf("cpuArchForABI(%q) = %q, want %q", tt.abi, got, tt.want)
			}
		})
	}
}

// TestClearStaleLocksRemovesKnownLockDirectories covers a real gap flagged
// in review: the emulator itself creates these AVD-instance-lock
// directories on boot and normally removes them on a clean exit, but a fast
// crash (e.g. the arm64 FATAL exit above) can leave them behind, which then
// makes the *next* boot attempt fail with "Running multiple emulators with
// the same AVD" even though nothing is actually running.
func TestClearStaleLocksRemovesKnownLockDirectories(t *testing.T) {
	avdDir := t.TempDir()
	for _, name := range []string{"hardware-qemu.ini.lock", "multiinstance.lock"} {
		if err := os.MkdirAll(filepath.Join(avdDir, name), 0o750); err != nil {
			t.Fatal(err)
		}
	}

	if err := ClearStaleLocks(avdDir); err != nil {
		t.Fatalf("ClearStaleLocks: %v", err)
	}

	for _, name := range []string{"hardware-qemu.ini.lock", "multiinstance.lock"} {
		if _, err := os.Stat(filepath.Join(avdDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s still exists after ClearStaleLocks (err=%v)", name, err)
		}
	}
}

func TestClearStaleLocksIsANoOpWhenNoneExist(t *testing.T) {
	if err := ClearStaleLocks(t.TempDir()); err != nil {
		t.Errorf("ClearStaleLocks on a clean AVD dir: %v, want nil", err)
	}
}

func TestWriteAVDConfigIsIdempotent(t *testing.T) {
	avdHome := t.TempDir()
	profile := DefaultProfile(34, "google_apis", "x86_64")

	if err := WriteAVDConfig(avdHome, "ao-default", profile, "system-images/android-34/google_apis/x86_64/"); err != nil {
		t.Fatalf("first WriteAVDConfig: %v", err)
	}
	if err := WriteAVDConfig(avdHome, "ao-default", profile, "system-images/android-34/google_apis/x86_64/"); err != nil {
		t.Fatalf("second WriteAVDConfig: %v", err)
	}
}
