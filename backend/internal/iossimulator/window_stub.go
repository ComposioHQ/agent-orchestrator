//go:build !darwin

package iossimulator

import "fmt"

type windowBounds struct{ X, Y, Width, Height float64 }

func simulatorWindowBounds() (windowBounds, error) {
	return windowBounds{}, fmt.Errorf("simulator window mapping is only supported on macOS")
}
