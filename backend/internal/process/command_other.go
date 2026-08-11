//go:build !windows

package process

import (
	"context"
	"os/exec"
)

func newCommand(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}

func newCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func configureHidden(_ *exec.Cmd) {}
