// Package androidemulator owns the lifecycle of AO's single, persistent,
// shared Android emulator: AVD configuration, host virtualization checks,
// process supervision, and quick-boot snapshot management.
package androidemulator

import (
	"fmt"
	"os"
	"path/filepath"
)

// DeviceProfile describes one fixed virtual device configuration. v1 ships
// one hardcoded default profile rather than a device/API-level picker UI, per
// the plan; a future version could resolve this dynamically against Android's
// device-definitions catalog.
type DeviceProfile struct {
	APILevel      int
	Tag           string // e.g. "google_apis"
	ABI           string // e.g. "x86_64"
	Width, Height int
	Density       int
}

// DefaultProfile returns AO's fixed default device profile: the exact
// dimensions/density verified interactive against a real emulator boot
// during the A0 spike (Pixel-class resolution, ~4.7fps screenshot-polling
// video).
func DefaultProfile(apiLevel int, tag, abi string) DeviceProfile {
	return DeviceProfile{
		APILevel: apiLevel,
		Tag:      tag,
		ABI:      abi,
		Width:    1080,
		Height:   2400,
		Density:  420,
	}
}

// staleLockNames are the AVD-instance-lock directories the emulator binary
// itself creates on boot (a real, confirmed, mkdir-based lock idiom — these
// are directories, not plain files) and normally removes on a clean exit.
var staleLockNames = []string{"hardware-qemu.ini.lock", "multiinstance.lock"}

// ClearStaleLocks removes any leftover AVD instance-lock directories under
// avdDir. Safe to call whether or not they exist.
//
// AO owns a single, fixed AVD (ao-default) whose entire lifecycle it
// controls through Manager's own state machine: if StartDevice is about to
// boot, Manager has already confirmed no instance is currently tracked as
// running. Any lock directories still on disk at that point can only be
// leftovers from a previous crash that didn't get a chance to clean up
// after itself (e.g. a fast FATAL exit) — never a real second instance — so
// clearing them unconditionally before every boot attempt is safe, and
// avoids a stale lock turning into a spurious "Running multiple emulators
// with the same AVD" failure on the next Start.
func ClearStaleLocks(avdDir string) error {
	for _, name := range staleLockNames {
		if err := os.RemoveAll(filepath.Join(avdDir, name)); err != nil {
			return fmt.Errorf("androidemulator: clear stale lock %s: %w", name, err)
		}
	}
	return nil
}

// cpuArchForABI maps a system-image ABI to the value config.ini's
// hw.cpu.arch field expects. ABI and CPU architecture are different
// vocabularies that happen to coincide on x86 ("x86_64"/"x86" are valid
// spellings for both), which is why passing the ABI straight through worked
// on Windows/Linux/Intel-mac CI and testing -- and fails hard on Apple
// Silicon: the real emulator binary refuses to boot with "FATAL | CPU
// Architecture 'arm64-v8a' is not supported by the QEMU2 emulator" (verified
// against a real boot; confirmed fixed by mapping to "arm64").
func cpuArchForABI(abi string) string {
	switch abi {
	case "arm64-v8a":
		return "arm64"
	case "armeabi-v7a", "armeabi":
		return "arm"
	default: // x86, x86_64
		return abi
	}
}

// WriteAVDConfig hand-writes the AVD pointer (<avdHome>/<avdName>.ini) and
// config (<avdHome>/<avdName>.avd/config.ini) files the emulator reads to
// boot, without going through avdmanager (a JRE dependency AO doesn't bundle).
//
// sysImageRelPath is the system image location relative to the SDK root
// (e.g. "system-images/android-34/google_apis/x86_64/", forward slashes —
// confirmed during the A0 spike that config.ini's image.sysdir.1 field
// tolerates forward slashes on Windows, unlike the pointer file's path=
// field below, which needs a native-OS-format absolute path).
func WriteAVDConfig(avdHome, avdName string, profile DeviceProfile, sysImageRelPath string) error {
	avdDir := filepath.Join(avdHome, avdName+".avd")
	if err := os.MkdirAll(avdDir, 0o750); err != nil {
		return fmt.Errorf("androidemulator: mkdir %s: %w", avdDir, err)
	}

	pointer := fmt.Sprintf("avd.ini.encoding=UTF-8\npath=%s\ntarget=android-%d\n", avdDir, profile.APILevel)
	pointerPath := filepath.Join(avdHome, avdName+".ini")
	if err := os.WriteFile(pointerPath, []byte(pointer), 0o600); err != nil {
		return fmt.Errorf("androidemulator: write %s: %w", pointerPath, err)
	}

	playStoreEnabled := "false"
	if profile.Tag == "google_apis_playstore" {
		playStoreEnabled = "true"
	}

	config := fmt.Sprintf(`avd.ini.encoding=UTF-8
AvdId=%s
PlayStore.enabled=%s
abi.type=%s
disk.dataPartition.size=6442450944
hw.accelerometer=yes
hw.audioInput=yes
hw.battery=yes
hw.camera.back=none
hw.camera.front=none
hw.cpu.arch=%s
hw.cpu.ncore=4
hw.gps=yes
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.initialOrientation=Portrait
hw.keyboard=yes
hw.lcd.density=%d
hw.lcd.height=%d
hw.lcd.width=%d
hw.mainKeys=no
hw.ramSize=2560
hw.sdCard=no
hw.sensors.orientation=yes
hw.sensors.proximity=yes
hw.trackBall=no
image.sysdir.1=%s
runtime.network.latency=none
runtime.network.speed=full
showDeviceFrame=no
skin.dynamic=yes
skin.name=%dx%d
skin.path=_no_skin
tag.display=Google APIs
tag.id=%s
tag.ids=%s
vm.heapSize=256
`, avdName, playStoreEnabled, profile.ABI, cpuArchForABI(profile.ABI), profile.Density, profile.Height, profile.Width,
		sysImageRelPath, profile.Width, profile.Height, profile.Tag, profile.Tag)

	configPath := filepath.Join(avdDir, "config.ini")
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		return fmt.Errorf("androidemulator: write %s: %w", configPath, err)
	}
	return nil
}
