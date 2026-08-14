package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// ensureTmux mirrors the pre-rewrite first-run flow: detect tmux before opening
// the desktop app, offer one interactive package-manager install, then verify
// the binary resolves. It does not block the app when installation is declined
// or impossible; the existing spawn prerequisite remains the hard backstop.
func (c *commandContext) ensureTmux(ctx context.Context, goos string, in io.Reader, out io.Writer) {
	if goos == "windows" || c.haveTmux() {
		return
	}

	argv := c.tmuxInstallCommand(goos)
	if len(argv) == 0 {
		c.warnTmuxMissing(out, goos, "install it with your package manager")
		return
	}
	pretty := strings.Join(argv, " ")
	if !stdinIsInteractive(in) {
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
		return
	}

	_, _ = fmt.Fprintf(out, "tmux is required to run terminal sessions on %s, but it is not installed.\n", goos)
	ok, err := confirm(in, out, fmt.Sprintf("Install it now with `%s`?", pretty), true)
	if err != nil || !ok {
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
		return
	}
	if err := c.installTmux(ctx, out, argv); err != nil {
		_, _ = fmt.Fprintf(out, "Warning: %v\n", err)
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
	}
}

func (c *commandContext) warnTmuxMissing(out io.Writer, goos, remedy string) {
	_, _ = fmt.Fprintf(out, "Warning: tmux is unavailable, so terminal sessions will fail to start on %s. To fix it, %s.\n", goos, remedy)
}

func (c *commandContext) installTmux(ctx context.Context, out io.Writer, argv []string) error {
	pretty := strings.Join(argv, " ")
	_, _ = fmt.Fprintf(out, "Running %s...\n", pretty)
	if err := c.deps.RunInteractive(ctx, argv[0], argv[1:]...); err != nil {
		return fmt.Errorf("install tmux with `%s`: %w", pretty, err)
	}
	if !c.haveTmux() {
		return fmt.Errorf("`%s` finished but tmux is still unavailable", pretty)
	}
	_, _ = fmt.Fprintln(out, "tmux installed.")
	return nil
}

func (c *commandContext) haveTmux() bool {
	path, err := c.deps.LookPath("tmux")
	return err == nil && path != ""
}

// tmuxInstallCommand returns the first supported package-manager command. Linux
// commands require root; an unprivileged process without sudo gets guidance but
// no doomed install attempt.
func (c *commandContext) tmuxInstallCommand(goos string) []string {
	var candidates [][]string
	switch goos {
	case "darwin":
		candidates = [][]string{{"brew", "install", "tmux"}}
	case "linux":
		candidates = [][]string{
			{"apt-get", "install", "-y", "tmux"},
			{"dnf", "install", "-y", "tmux"},
			{"pacman", "-S", "--noconfirm", "tmux"},
			{"zypper", "install", "-y", "tmux"},
			{"apk", "add", "tmux"},
		}
	default:
		return nil
	}
	for _, argv := range candidates {
		if path, err := c.deps.LookPath(argv[0]); err != nil || path == "" {
			continue
		}
		return c.withTmuxInstallPrivilege(goos, argv)
	}
	return nil
}

func (c *commandContext) withTmuxInstallPrivilege(goos string, argv []string) []string {
	if goos != "linux" || os.Geteuid() == 0 {
		return argv
	}
	if path, err := c.deps.LookPath("sudo"); err != nil || path == "" {
		return nil
	}
	return append([]string{"sudo"}, argv...)
}
