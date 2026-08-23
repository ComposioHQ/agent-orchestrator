package ports

import (
	"context"
	"io"
)

// ExecutableFinder resolves command names against the host PATH. Core
// services depend on this port rather than importing os/exec directly.
type ExecutableFinder interface {
	LookPath(file string) (string, error)
}

// CommandRunner executes an already-resolved argv and streams output to the
// supplied writers. Callers are responsible for constraining argv to a safe
// allowlist before it reaches this boundary.
type CommandRunner interface {
	Run(ctx context.Context, argv []string, stdout, stderr io.Writer) error
}
