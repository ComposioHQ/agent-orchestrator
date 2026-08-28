package cli

import (
	"errors"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/persistenthost"
)

func newChatHostCommand() *cobra.Command {
	return &cobra.Command{
		Use:                "chat-host",
		Short:              "Run a persistent Chat provider host (internal)",
		Hidden:             true,
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) < 5 || args[3] != "--" {
				return usageError{errors.New("chat-host requires <session> <data-dir> <workdir> -- <provider> [args...]")}
			}
			return persistenthost.Run(cmd.Context(), persistenthost.Config{
				SessionID: strings.TrimSpace(args[0]),
				DataDir:   args[1],
				Workdir:   args[2],
				Env:       os.Environ(),
				Argv:      args[4:],
			})
		},
	}
}
