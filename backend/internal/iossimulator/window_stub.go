//go:build !darwin

package iossimulator

import "fmt"

type windowBounds struct{ X, Y, Width, Height float64 }

func focusSimulator() error {
	return fmt.Errorf("simulator activation is only supported on macOS")
}

func simulatorWindowBounds() (windowBounds, error) {
	return windowBounds{}, fmt.Errorf("simulator window mapping is only supported on macOS")
}
