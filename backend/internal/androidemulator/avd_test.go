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
