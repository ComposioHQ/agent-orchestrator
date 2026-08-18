package cli

import (
	"errors"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/reviewer/greptile"
)

// newReviewTerminalCommand is the hidden runner used by the Greptile reviewer
// terminal. It deliberately has no submit/chat flags: the daemon owns
// persistence and GitHub publication after this command writes its structured
// sidecar. Once complete, the terminal becomes a normal user shell.
func newReviewTerminalCommand() *cobra.Command {
	return &cobra.Command{
		Use:                "review-terminal <request-file>",
		Short:              "Run a Greptile review terminal (internal)",
		Hidden:             true,
		DisableFlagParsing: true,
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) != 1 || args[0] == "" {
				return usageError{errors.New("usage: ao review-terminal <request-file>")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := greptile.RunTerminal(cmd.Context(), args[0], cmd.OutOrStdout()); err != nil {
				return err
			}
			return greptile.RunTerminalShell(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
}
