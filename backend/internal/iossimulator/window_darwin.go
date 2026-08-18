//go:build darwin

package iossimulator

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

type windowBounds struct{ X, Y, Width, Height float64 }

// focusSimulator makes Simulator.app the active application so its device
// shortcuts (Home, rotate) land on it. The app is already running at this
// point; `open -a` activates the existing instance without launching a second
// one. Capture deliberately does not depend on this — only the shortcut
// actions call it.
func focusSimulator() error {
	out, err := exec.Command("open", "-a", "Simulator").Output()
	if err != nil {
		return fmt.Errorf("activate Simulator.app: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func simulatorWindowBounds() (windowBounds, error) {
	script := `tell application "System Events" to tell process "Simulator" to set r to {position of window 1, size of window 1} as text`
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return windowBounds{}, fmt.Errorf("accessibility permission may be missing: %w", err)
	}
	parts := strings.FieldsFunc(string(out), func(r rune) bool { return r == ',' || r == '}' || r == '{' || r == ' ' || r == '\n' })
	if len(parts) < 4 {
		return windowBounds{}, fmt.Errorf("unexpected Simulator window bounds %q", out)
	}
	values := make([]float64, 4)
	for i := range values {
		values[i], err = strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
		if err != nil {
			return windowBounds{}, err
		}
	}
	return windowBounds{X: values[0], Y: values[1], Width: values[2], Height: values[3]}, nil
}
