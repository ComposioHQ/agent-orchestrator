package cli

import (
	"context"
	"fmt"
	"net/url"

	"github.com/spf13/cobra"
)

// conversationSnapshotDTO mirrors the subset of the daemon's
// ConversationSnapshotResponse (GET /api/v1/sessions/{id}/conversation) the CLI
// needs. The CLI keeps its own copy so it need not import httpd/controllers.
type conversationSnapshotDTO struct {
	ConversationID string                   `json:"conversationId"`
	ActiveBranchID string                   `json:"activeBranchId,omitempty"`
	SessionID      string                   `json:"sessionId"`
	Mode           string                   `json:"mode"`
	Controller     string                   `json:"controller"`
	Title          string                   `json:"title,omitempty"`
	LatestSequence int64                    `json:"latestSequence"`
	Turns          []conversationTurnDTO    `json:"turns"`
	Messages       []conversationMessageDTO `json:"messages"`
}

// conversationTurnDTO mirrors ConversationTurnResponse.
type conversationTurnDTO struct {
	ID           string  `json:"id"`
	State        string  `json:"state" enum:"queued,running,completed,recovered,interrupted,failed,cancelled"`
	ErrorMessage string  `json:"errorMessage,omitempty"`
	RequestedAt  string  `json:"requestedAt"`
	CompletedAt  *string `json:"completedAt,omitempty"`
	RolledBack   bool    `json:"rolledBack,omitempty"`
}

// conversationMessageDTO mirrors ConversationMessageResponse.
type conversationMessageDTO struct {
	ID        string `json:"id"`
	TurnID    string `json:"turnId,omitempty"`
	Sequence  int64  `json:"sequence"`
	Role      string `json:"role" enum:"user,assistant"`
	Origin    string `json:"origin" enum:"human,automation,daemon,provider"`
	Text      string `json:"text"`
	Streaming bool   `json:"streaming"`
	CreatedAt string `json:"createdAt"`
}

func newSessionConversationCommand(ctx *commandContext) *cobra.Command {
	var opts sessionOptions
	cmd := &cobra.Command{
		Use:   "conversation <id>",
		Short: "Show a session's stored conversation transcript",
		Long: "Show the canonical conversation transcript for a session — the same turns and\n" +
			"messages the daemon stores for its chat UI, exposed as a diagnostic view.\n" +
			"For consuming a worker's finished output, prefer `ao session result`.",
		Args: oneSessionIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := normalizeSessionID(args[0])
			if err != nil {
				return err
			}
			return ctx.getSessionConversation(cmd.Context(), cmd, id, opts)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func (c *commandContext) getSessionConversation(ctx context.Context, cmd *cobra.Command, id string, opts sessionOptions) error {
	snapshot, err := c.fetchConversationSnapshot(ctx, id)
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), snapshot)
	}
	return writeConversationTranscript(cmd, snapshot)
}

// fetchConversationSnapshot calls the daemon's existing conversation endpoint.
// It is the sole place the CLI reaches into session conversation state, and
// `ao session result` builds on it rather than adding a second route.
func (c *commandContext) fetchConversationSnapshot(ctx context.Context, id string) (conversationSnapshotDTO, error) {
	var snapshot conversationSnapshotDTO
	if err := c.getJSON(ctx, "sessions/"+url.PathEscape(id)+"/conversation", &snapshot); err != nil {
		return conversationSnapshotDTO{}, err
	}
	return snapshot, nil
}

func writeConversationTranscript(cmd *cobra.Command, snapshot conversationSnapshotDTO) error {
	out := cmd.OutOrStdout()
	if _, err := fmt.Fprintf(out, "session: %s\n", snapshot.SessionID); err != nil {
		return err
	}
	if snapshot.Title != "" {
		if _, err := fmt.Fprintf(out, "title: %s\n", snapshot.Title); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "controller: %s\n\n", snapshot.Controller); err != nil {
		return err
	}
	if len(snapshot.Messages) == 0 && len(snapshot.Turns) == 0 {
		_, err := fmt.Fprintln(out, "(no conversation activity yet)")
		return err
	}
	turnState := make(map[string]string, len(snapshot.Turns))
	for _, turn := range snapshot.Turns {
		turnState[turn.ID] = turn.State
	}
	for _, msg := range snapshot.Messages {
		state := turnState[msg.TurnID]
		if state != "" {
			state = " turn:" + state
		}
		if _, err := fmt.Fprintf(out, "[%s]%s %s\n", msg.Role, state, msg.Text); err != nil {
			return err
		}
	}
	return nil
}
