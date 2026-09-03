package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

// newClaudeCodeLoginCommand is an internal terminal entry point that lets the
// user choose a native Claude OAuth flow before Claude opens a browser.
func newClaudeCodeLoginCommand(ctx *commandContext) *cobra.Command {
	var claudeBinary string
	command := &cobra.Command{
		Use:    "claude-code-login",
		Short:  "Sign a managed Claude Code account in (internal)",
		Hidden: true,
		Args:   noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.runClaudeCodeLogin(cmd.Context(), claudeBinary, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
	command.Flags().StringVar(&claudeBinary, "claude-binary", "", "resolved Claude Code executable (internal)")
	_ = command.Flags().MarkHidden("claude-binary")
	return command
}

func (c *commandContext) runClaudeCodeLogin(ctx context.Context, claudeBinary string, in io.Reader, out, stderr io.Writer) error {
	claude := strings.TrimSpace(claudeBinary)
	if claude == "" {
		var err error
		claude, err = c.deps.LookPath("claude")
		if err != nil {
			return fmt.Errorf("claude CLI is not installed or is not available on PATH")
		}
	}
	style := newAccountLoginStyle(out)
	if err := writeClaudeCodeLoginMenu(out, style); err != nil {
		return err
	}
	selection, err := readAccountLoginSelection(in)
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read login method: %w", err)
	}

	args := []string{"auth", "login"}
	switch strings.TrimSpace(selection) {
	case "1":
		args = append(args, "--claudeai")
	case "2":
		args = append(args, "--claudeai", "--sso")
	case "3":
		args = append(args, "--console")
	default:
		return usageError{fmt.Errorf("login method must be 1, 2, or 3")}
	}

	if err := c.deps.RunInteractiveCommand(ctx, claude, args, in, out, stderr); err != nil {
		return fmt.Errorf("claude login failed: %w", err)
	}
	if _, err := fmt.Fprintf(out, "\n%s\n", style.success("Claude Code sign-in complete.")); err != nil {
		return err
	}
	return nil
}

func writeClaudeCodeLoginMenu(out io.Writer, style accountLoginStyle) error {
	lines := []string{
		style.accent("Sign in to Claude Code"),
		style.dim("Choose how you want to authenticate this account."),
		"",
		style.dim("CLAUDE ACCOUNT"),
		fmt.Sprintf("  %s  %s  %s %s", style.accent("1"), style.bold("Claude account in browser"), style.success("Recommended"), style.dim("· Pro, Max, Team, or Enterprise")),
		fmt.Sprintf("  %s  %s %s", style.accent("2"), style.bold("Enterprise SSO"), style.dim("· Organization-managed sign-in")),
		"",
		style.dim("DEVELOPER ACCOUNT"),
		fmt.Sprintf("  %s  %s %s", style.accent("3"), style.bold("Anthropic Console"), style.dim("· API usage billing")),
		"",
		style.bold("Enter 1-3 and press Return"),
		style.dim("Ctrl+C to cancel"),
	}
	if _, err := fmt.Fprintln(out, strings.Join(lines, "\n")); err != nil {
		return err
	}
	_, err := fmt.Fprint(out, style.accent("Selection [1-3]: "))
	return err
}
