package androidemulator

import (
	"errors"
	"testing"
)

func TestParseAccelCheckOutputAvailable(t *testing.T) {
	// Captured verbatim from a real `emulator.exe -accel-check` run on this
	// Windows machine during the A0 spike.
	output := []byte("accel:\n0\nWHPX(10.0.26200) is installed and usable.\naccel\n")
	got := parseAccelCheckOutput(output, nil)
	if !got.Available {
		t.Errorf("Available = false, want true for %q", output)
	}
	if got.Detail == "" {
		t.Error("Detail is empty, want the raw diagnostic text")
	}
}

func TestParseAccelCheckOutputUnavailableOnNonZeroExit(t *testing.T) {
	// The "unavailable" output format was not observed directly during the A0
	// spike (this dev machine has working WHPX) -- this covers the
	// conservative fallback: a nonzero exit from -accel-check means treat
	// acceleration as unavailable rather than guessing it's fine.
	got := parseAccelCheckOutput([]byte("accel:\n1\nHAXM is not installed.\naccel\n"), errors.New("exit status 1"))
	if got.Available {
		t.Error("Available = true, want false when -accel-check exits nonzero")
	}
}

func TestParseAccelCheckOutputUnavailableWithoutUsableMarker(t *testing.T) {
	// Even a zero exit shouldn't be trusted blindly -- require the positive
	// "is installed and usable" marker the real tool emits, not just "ran
	// without error".
	got := parseAccelCheckOutput([]byte("accel:\n0\nSomething unexpected happened.\naccel\n"), nil)
	if got.Available {
		t.Error("Available = true, want false without the usable marker")
	}
}
