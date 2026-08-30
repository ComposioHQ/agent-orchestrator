package androidemulator

import (
	"context"
	"errors"
	"testing"
)

func TestParseEmulatorSerialsSkipsHeaderAndUnusableDevices(t *testing.T) {
	// Real `adb devices` output: a header line, a blank trailing line, and
	// device states other than "device" (offline/unauthorized) that cannot
	// answer an `emu avd name` query.
	out := []byte("List of devices attached\n" +
		"emulator-5554\tdevice\n" +
		"emulator-5556\toffline\n" +
		"emulator-5558\tdevice\n" +
		"3A21FDH200\tdevice\n" +
		"\n")

	got := parseEmulatorSerials(out)

	want := []string{"emulator-5554", "emulator-5558"}
	if len(got) != len(want) {
		t.Fatalf("parseEmulatorSerials = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("parseEmulatorSerials[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestResolveSerialFindsAODeviceBehindAnotherEmulator(t *testing.T) {
	// The case that breaks a hardcoded emulator-5554: the user's own
	// emulator booted first and claimed 5554, so AO's AVD is on 5556.
	deps := serialLookupDeps{
		listDevices: func(context.Context) ([]byte, error) {
			return []byte("List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n"), nil
		},
		avdName: func(_ context.Context, serial string) (string, error) {
			switch serial {
			case "emulator-5554":
				return "kickchain\nOK\n", nil
			case "emulator-5556":
				return "ao-default\nOK\n", nil
			}
			return "", errors.New("unexpected serial " + serial)
		},
	}

	got, ok := resolveSerialWithDeps(context.Background(), deps, "ao-default")

	if !ok || got != "emulator-5556" {
		t.Errorf("resolveSerialWithDeps = (%q, %v), want (\"emulator-5556\", true)", got, ok)
	}
}

func TestResolveSerialReportsNotFoundWhenAODeviceIsAbsent(t *testing.T) {
	// Must not fall back to "some emulator": targeting the wrong device is
	// worse than reporting the AO device isn't up yet.
	deps := serialLookupDeps{
		listDevices: func(context.Context) ([]byte, error) {
			return []byte("List of devices attached\nemulator-5554\tdevice\n"), nil
		},
		avdName: func(context.Context, string) (string, error) { return "kickchain\nOK\n", nil },
	}

	got, ok := resolveSerialWithDeps(context.Background(), deps, "ao-default")

	if ok || got != "" {
		t.Errorf("resolveSerialWithDeps = (%q, %v), want (\"\", false)", got, ok)
	}
}

func TestResolveSerialSkipsDevicesThatFailTheAVDNameQuery(t *testing.T) {
	// A device that errors (still booting, or not an emulator console) must
	// not abort the search for the remaining candidates.
	deps := serialLookupDeps{
		listDevices: func(context.Context) ([]byte, error) {
			return []byte("List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n"), nil
		},
		avdName: func(_ context.Context, serial string) (string, error) {
			if serial == "emulator-5554" {
				return "", errors.New("device offline")
			}
			return "ao-default\nOK\n", nil
		},
	}

	got, ok := resolveSerialWithDeps(context.Background(), deps, "ao-default")

	if !ok || got != "emulator-5556" {
		t.Errorf("resolveSerialWithDeps = (%q, %v), want (\"emulator-5556\", true)", got, ok)
	}
}
