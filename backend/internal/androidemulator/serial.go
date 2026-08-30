package androidemulator

import (
	"context"
	"os/exec"
	"strings"
)

// serialLookupDeps is the seam that lets the serial resolution logic be
// tested without a real adb/device, mirroring uiInspectDeps.
type serialLookupDeps struct {
	listDevices func(ctx context.Context) ([]byte, error)
	avdName     func(ctx context.Context, serial string) (string, error)
}

// ResolveSerial finds the adb serial of the running emulator whose AVD is
// avdName.
//
// AO cannot assume its device is emulator-5554: that is only true when AO's
// emulator is the first one running on the host. A developer with their own
// AVD already booted pushes AO's device to 5556 or higher, and a hardcoded
// serial then silently targets *their* device -- for readiness polling, UI
// inspection, and anything else keyed off the serial.
func ResolveSerial(ctx context.Context, adbPath, avdName string) (string, bool) {
	deps := serialLookupDeps{
		listDevices: func(ctx context.Context) ([]byte, error) {
			return exec.CommandContext(ctx, adbPath, "devices").Output()
		},
		avdName: func(ctx context.Context, serial string) (string, error) {
			out, err := exec.CommandContext(ctx, adbPath, "-s", serial, "emu", "avd", "name").Output()
			return string(out), err
		},
	}
	return resolveSerialWithDeps(ctx, deps, avdName)
}

func resolveSerialWithDeps(ctx context.Context, deps serialLookupDeps, want string) (string, bool) {
	out, err := deps.listDevices(ctx)
	if err != nil {
		return "", false
	}
	for _, serial := range parseEmulatorSerials(out) {
		name, err := deps.avdName(ctx, serial)
		if err != nil {
			// Still booting, or the console did not answer. Other
			// candidates may still match, so keep looking.
			continue
		}
		if firstLine(name) == want {
			return serial, true
		}
	}
	// Deliberately no "any emulator" fallback: driving the wrong device is
	// worse than reporting AO's device is not up yet.
	return "", false
}

// parseEmulatorSerials returns the serials of attached emulators in the
// "device" state, in `adb devices` order. Devices that are offline or
// unauthorized are skipped: they cannot answer an `emu avd name` query.
func parseEmulatorSerials(out []byte) []string {
	var serials []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(strings.TrimRight(line, "\r"))
		if len(fields) != 2 || fields[1] != "device" {
			continue
		}
		if !strings.HasPrefix(fields[0], "emulator-") {
			continue
		}
		serials = append(serials, fields[0])
	}
	return serials
}

// firstLine trims `adb emu avd name` output down to the name itself: the
// console appends its own "OK" status line after the value.
func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return strings.TrimSpace(line)
}
