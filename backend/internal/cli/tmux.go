package cli

import (
	"context"
	"fmt"
	"io"
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
	steps := tmuxInstallSteps(argv)
	pretty := formatTmuxInstallSteps(steps)
	if c.tmuxInstallNeedsRoot(goos, argv) {
		c.warnTmuxMissing(out, goos, fmt.Sprintf("run as root: `%s`", pretty))
		return
	}
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
	if err := c.installTmux(ctx, out, steps); err != nil {
		_, _ = fmt.Fprintf(out, "Warning: %v\n", err)
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
	}
}

func (c *commandContext) warnTmuxMissing(out io.Writer, goos, remedy string) {
	_, _ = fmt.Fprintf(out, "Warning: tmux is unavailable, so terminal sessions will fail to start on %s. To fix it, %s.\n", goos, remedy)
}

func (c *commandContext) installTmux(ctx context.Context, out io.Writer, steps [][]string) error {
	pretty := formatTmuxInstallSteps(steps)
	_, _ = fmt.Fprintf(out, "Running %s...\n", pretty)
	for _, argv := range steps {
		if err := c.deps.RunInteractive(ctx, argv[0], argv[1:]...); err != nil {
			return fmt.Errorf("install tmux with `%s`: `%s` failed: %w", pretty, strings.Join(argv, " "), err)
		}
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
// commands require root; an unprivileged process without sudo keeps the bare
// command so ensureTmux can explain both the command and the missing privilege.
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
	if goos != "linux" || c.deps.EffectiveUID() == 0 {
		return argv
	}
	if path, err := c.deps.LookPath("sudo"); err != nil || path == "" {
		return argv
	}
	return append([]string{"sudo"}, argv...)
}

func (c *commandContext) tmuxInstallNeedsRoot(goos string, argv []string) bool {
	return goos == "linux" && c.deps.EffectiveUID() != 0 && len(argv) > 0 && argv[0] != "sudo"
}

// tmuxInstallSteps refreshes apt's package index before installing. Fresh
// Debian/Ubuntu images commonly have an empty index, and the prompt must show
// both commands before the user consents.
func tmuxInstallSteps(argv []string) [][]string {
	manager := 0
	if len(argv) > 0 && argv[0] == "sudo" {
		manager = 1
	}
	if manager < len(argv) && argv[manager] == "apt-get" {
		update := append([]string(nil), argv[:manager+1]...)
		update = append(update, "update")
		return [][]string{update, argv}
	}
	return [][]string{argv}
}

func formatTmuxInstallSteps(steps [][]string) string {
	commands := make([]string, 0, len(steps))
	for _, argv := range steps {
		commands = append(commands, strings.Join(argv, " "))
	}
	return strings.Join(commands, " && ")
}
