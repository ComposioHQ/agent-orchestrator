//go:build windows

package process

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func newCommand(name string, args ...string) *exec.Cmd {
	if resolved, ok := windowsBatchPath(name); ok {
		cmd := exec.Command(windowsCommandInterpreter()) //nolint:gosec // COMSPEC is the OS-selected interpreter required for .cmd/.bat shims.
		configureWindowsBatch(cmd, resolved, args)
		return cmd
	}
	return exec.Command(name, args...)
}

func newCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	if resolved, ok := windowsBatchPath(name); ok {
		cmd := exec.CommandContext(ctx, windowsCommandInterpreter()) //nolint:gosec // COMSPEC is the OS-selected interpreter required for .cmd/.bat shims.
		configureWindowsBatch(cmd, resolved, args)
		return cmd
	}
	return exec.CommandContext(ctx, name, args...)
}

func windowsBatchPath(name string) (string, bool) {
	resolved, err := exec.LookPath(name)
	if err != nil {
		return "", false
	}
	extension := filepath.Ext(resolved)
	return resolved, strings.EqualFold(extension, ".cmd") || strings.EqualFold(extension, ".bat")
}

func windowsCommandInterpreter() string {
	if shell := strings.TrimSpace(os.Getenv("COMSPEC")); shell != "" {
		return shell
	}
	return "cmd.exe"
}

func configureWindowsBatch(cmd *exec.Cmd, executable string, args []string) {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteWindowsBatchArg(executable))
	for _, arg := range args {
		parts = append(parts, quoteWindowsBatchArg(arg))
	}
	cmd.Args = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: `/d /s /c "` + strings.Join(parts, " ") + `"`,
	}
}

func quoteWindowsBatchArg(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func configureHidden(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
	cmd.SysProcAttr.HideWindow = true
}
