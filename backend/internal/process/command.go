package process

import (
	"context"
	"os/exec"
)

// Command creates a non-interactive child process. On Windows it suppresses
// transient console windows for CLI tools launched by the desktop daemon.
func Command(name string, args ...string) *exec.Cmd {
	cmd := newCommand(name, args...)
	configureHidden(cmd)
	return cmd
}

// CommandContext is Command with cancellation support.
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := newCommandContext(ctx, name, args...)
	configureHidden(cmd)
	return cmd
}

// AttachedCommandContext creates a child that remains attached to its parent's
// terminal. It retains the platform command handling from CommandContext (for
// example, Windows .cmd/.bat shims) but deliberately skips hidden-console flags
// that make nested TUI processes report stdout as non-TTY.
func AttachedCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return newCommandContext(ctx, name, args...)
}
