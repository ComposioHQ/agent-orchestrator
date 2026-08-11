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
	if err := os.MkdirAll(avdDir, 0o755); err != nil {
		return fmt.Errorf("androidemulator: mkdir %s: %w", avdDir, err)
	}

	pointer := fmt.Sprintf("avd.ini.encoding=UTF-8\npath=%s\ntarget=android-%d\n", avdDir, profile.APILevel)
	pointerPath := filepath.Join(avdHome, avdName+".ini")
	if err := os.WriteFile(pointerPath, []byte(pointer), 0o644); err != nil {
		return fmt.Errorf("androidemulator: write %s: %w", pointerPath, err)
	}

	config := fmt.Sprintf(`avd.ini.encoding=UTF-8
AvdId=%s
PlayStore.enabled=false
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
hw.ramSize=2048
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
`, avdName, profile.ABI, profile.ABI, profile.Density, profile.Height, profile.Width,
		sysImageRelPath, profile.Width, profile.Height, profile.Tag, profile.Tag)

	configPath := filepath.Join(avdDir, "config.ini")
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		return fmt.Errorf("androidemulator: write %s: %w", configPath, err)
	}
	return nil
}
