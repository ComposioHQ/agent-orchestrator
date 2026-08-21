package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/service/systeminstall"
)

// ensureTmux satisfies the tmux runtime prerequisite before the desktop app is
// launched, instead of letting the user discover it as an opaque
// RUNTIME_PREREQUISITE_MISSING error on their first spawn. It only prints the
// exact command to run by hand; installation belongs to the daemon-owned
// desktop flow, never to this bootstrap CLI.
//
// It never blocks `ao start`. Back when ensureTmux() ran in the CLI, `ao start`
// WAS the daemon, so no tmux meant nothing could work. It is now only the
// desktop-app launcher, and the app is still usable without a session runtime,
// so an unmet prerequisite is a warning here and remains a hard error at spawn.
func (c *commandContext) ensureTmux(_ context.Context, goos string, _ io.Reader, out io.Writer) {
	// Windows uses the ConPTY runtime, which needs no tmux. This mirrors
	// systemcheck's Windows branch so the CLI and the desktop gate agree.
	if goos == "windows" || c.haveTmux() {
		return
	}

	argv := c.tmuxInstallCommand(goos)
	if len(argv) == 0 {
		c.warnTmuxMissing(out, goos, "install it with your package manager")
		return
	}
	pretty := strings.Join(argv, " ")

	c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
}

// warnTmuxMissing states the consequence and the remedy, and is the only thing
// a user gets when we cannot install for them.
func (c *commandContext) warnTmuxMissing(out io.Writer, goos, remedy string) {
	_, _ = fmt.Fprintf(out, "Warning: tmux is not in PATH, so agent sessions will fail to start on %s. To fix it, %s.\n", goos, remedy)
}

func (c *commandContext) haveTmux() bool {
	// goos is irrelevant here: callers have already excluded Windows, and this
	// asks the narrower question of whether the binary exists.
	path, err := c.deps.LookPath("tmux")
	return err == nil && path != ""
}

// tmuxInstallCommand returns the install argv for the first known package
// manager present on PATH, or nil when there is none.
//
// It deliberately keys off len(Command) rather than Plan.Unsupported: on Linux
// the daemon marks every package-manager plan Unsupported because it must not
// elevate, but the command itself is correct and this caller can run it.
func (c *commandContext) tmuxInstallCommand(goos string) []string {
	plan := systeminstall.Resolve(goos, c.deps.LookPath, systeminstall.TargetTmux)
	if len(plan.Command) == 0 {
		return nil
	}
	return manualInstallCommand(plan)
}

// manualInstallCommand prefixes sudo when the resolved package manager writes
// to system paths. The command is advice, not something this process executes,
// so it remains exact even when sudo itself is not currently on PATH.
func manualInstallCommand(plan systeminstall.Plan) []string {
	if !plan.NeedsRoot || os.Geteuid() == 0 {
		return plan.Command
	}
	return append([]string{"sudo"}, plan.Command...)
}
