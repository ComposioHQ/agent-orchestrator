package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"
)

// sessionResultStatus classifies what `ao session result` found in the
// session's stored conversation. It is the stable field an orchestrator
// scripts against, so the values here are part of the CLI's contract.
type sessionResultStatus string

const (
	// sessionResultStatusCompleted means the session's most recent (non
	// rolled-back) turn finished and produced an assistant message. Result
	// carries that message's exact text.
	sessionResultStatusCompleted sessionResultStatus = "completed"
	// sessionResultStatusRunning means the session has no result yet: either
	// no turn has been requested, or the most recent turn is still queued or
	// running.
	sessionResultStatusRunning sessionResultStatus = "running"
	// sessionResultStatusFailed means the most recent turn ended without
	// producing a result: failed, was interrupted, or was cancelled.
	sessionResultStatusFailed sessionResultStatus = "failed"
	// sessionResultStatusMalformed means the stored conversation contradicts
	// its own turn state (e.g. a turn marked completed with no assistant
	// message, or an unrecognized turn state). The CLI never invents a result
	// to paper over this — it is reported as an error instead.
	sessionResultStatusMalformed sessionResultStatus = "malformed"
)

// sessionResultOutput is the stable JSON shape for `ao session result --json`.
type sessionResultOutput struct {
	SessionID    string `json:"sessionId"`
	Status       string `json:"status" enum:"completed,running,failed,malformed"`
	TurnID       string `json:"turnId,omitempty"`
	TurnState    string `json:"turnState,omitempty"`
	Result       string `json:"result,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// summary renders the non-completed statuses as a one-line explanation, used
// both for the human-readable output and as the command's returned error text.
func (r sessionResultOutput) summary() string {
	switch sessionResultStatus(r.Status) {
	case sessionResultStatusRunning:
		if r.TurnID == "" {
			return "session has not started a turn yet"
		}
		return fmt.Sprintf("turn %s is still %s", r.TurnID, r.TurnState)
	case sessionResultStatusFailed:
		if r.ErrorMessage != "" {
			return fmt.Sprintf("turn %s ended as %s without a result: %s", r.TurnID, r.TurnState, r.ErrorMessage)
		}
		return fmt.Sprintf("turn %s ended as %s without a result", r.TurnID, r.TurnState)
	case sessionResultStatusMalformed:
		return "conversation state is malformed: " + r.ErrorMessage
	default:
		return ""
	}
}

func newSessionResultCommand(ctx *commandContext) *cobra.Command {
	var opts sessionOptions
	cmd := &cobra.Command{
		Use:   "result <id>",
		Short: "Fetch a session's completed terminal assistant result",
		Long: "Fetch the final completed assistant message for a session, derived from its\n" +
			"stored conversation (never generated, summarized, or inferred). Exits non-zero\n" +
			"when the session has no completed result yet: still running, or ended without\n" +
			"one.\n\n" +
			"This is the way an orchestrator should consume a worker session's output —\n" +
			"prefer it over `ao session conversation`, which returns the full transcript.",
		Example: `  ao session result mer-3
  ao session result mer-3 --json`,
		Args: oneSessionIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := normalizeSessionID(args[0])
			if err != nil {
				return err
			}
			return ctx.sessionResult(cmd.Context(), cmd, id, opts)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func (c *commandContext) sessionResult(ctx context.Context, cmd *cobra.Command, id string, opts sessionOptions) error {
	snapshot, err := c.fetchConversationSnapshot(ctx, id)
	if err != nil {
		return err
	}
	result := deriveSessionResult(id, snapshot)

	if opts.json {
		if err := writeJSON(cmd.OutOrStdout(), result); err != nil {
			return err
		}
	} else if err := writeSessionResultText(cmd, result); err != nil {
		return err
	}

	if sessionResultStatus(result.Status) != sessionResultStatusCompleted {
		return fmt.Errorf("session %s has no completed result: %s", id, result.summary())
	}
	return nil
}

func writeSessionResultText(cmd *cobra.Command, result sessionResultOutput) error {
	out := cmd.OutOrStdout()
	if sessionResultStatus(result.Status) == sessionResultStatusCompleted {
		_, err := fmt.Fprintln(out, result.Result)
		return err
	}
	_, err := fmt.Fprintf(out, "session %s: %s (%s)\n", result.SessionID, result.summary(), result.Status)
	return err
}

// deriveSessionResult picks the session's terminal assistant result out of its
// stored conversation. It never generates, summarizes, or fabricates content:
// every field it returns is copied verbatim from the daemon's own turn and
// message records.
func deriveSessionResult(sessionID string, snapshot conversationSnapshotDTO) sessionResultOutput {
	turn, ok := lastActiveTurn(snapshot.Turns)
	if !ok {
		return sessionResultOutput{SessionID: sessionID, Status: string(sessionResultStatusRunning)}
	}

	switch turn.State {
	case "queued", "running":
		return sessionResultOutput{
			SessionID: sessionID, Status: string(sessionResultStatusRunning),
			TurnID: turn.ID, TurnState: turn.State,
		}

	case "completed", "recovered":
		msg, ok := lastAssistantMessageForTurn(snapshot.Messages, turn.ID)
		if !ok {
			return sessionResultOutput{
				SessionID: sessionID, Status: string(sessionResultStatusMalformed),
				TurnID: turn.ID, TurnState: turn.State,
				ErrorMessage: fmt.Sprintf("turn %s is %s but the conversation has no assistant message for it", turn.ID, turn.State),
			}
		}
		if msg.Streaming {
			return sessionResultOutput{
				SessionID: sessionID, Status: string(sessionResultStatusMalformed),
				TurnID: turn.ID, TurnState: turn.State,
				ErrorMessage: fmt.Sprintf("turn %s is %s but its assistant message is still streaming", turn.ID, turn.State),
			}
		}
		return sessionResultOutput{
			SessionID: sessionID, Status: string(sessionResultStatusCompleted),
			TurnID: turn.ID, TurnState: turn.State, Result: msg.Text,
		}

	case "failed", "interrupted", "cancelled":
		return sessionResultOutput{
			SessionID: sessionID, Status: string(sessionResultStatusFailed),
			TurnID: turn.ID, TurnState: turn.State, ErrorMessage: turn.ErrorMessage,
		}

	default:
		return sessionResultOutput{
			SessionID: sessionID, Status: string(sessionResultStatusMalformed),
			TurnID: turn.ID, TurnState: turn.State,
			ErrorMessage: fmt.Sprintf("unrecognized turn state %q", turn.State),
		}
	}
}

// lastActiveTurn returns the most recent turn that was not rolled back. Turns
// arrive ordered oldest-first, matching the daemon's stored request order,
// and a rolled-back turn's messages are absent from the snapshot -- so a
// rolled-back last turn is skipped rather than reported as the result.
func lastActiveTurn(turns []conversationTurnDTO) (conversationTurnDTO, bool) {
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].RolledBack {
			continue
		}
		return turns[i], true
	}
	return conversationTurnDTO{}, false
}

// lastAssistantMessageForTurn returns the latest assistant message recorded
// against a turn. Messages arrive ordered oldest-first, so the last match is
// the turn's final assistant output rather than an earlier intermediate one.
func lastAssistantMessageForTurn(messages []conversationMessageDTO, turnID string) (conversationMessageDTO, bool) {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].TurnID == turnID && messages[i].Role == "assistant" {
			return messages[i], true
		}
	}
	return conversationMessageDTO{}, false
}
