package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	agyChatHookTokenHeader = "X-AO-Agy-Hook-Token"
	agyChatHookTokenEnv    = "AO_AGY_CHAT_HOOK_TOKEN"
	maxAgyChatHookPayload  = 4 << 20
)

type agyChatHookRequest struct {
	Payload json.RawMessage `json:"payload"`
}

func newAgyChatHookCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:    "agy-chat-hook <event>",
		Short:  "Internal Agy Chat hook bridge",
		Hidden: true,
		Args:   usageArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			event := strings.TrimSpace(args[0])
			if event != "pre-invocation" && event != "pre-tool-use" {
				return usageError{err: fmt.Errorf("unsupported Agy Chat hook event %q", event)}
			}
			return runAgyChatHook(cmd, ctx, event)
		},
	}
}

func runAgyChatHook(cmd *cobra.Command, ctx *commandContext, event string) error {
	payload, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), maxAgyChatHookPayload+1))
	if err != nil {
		return agyChatHookFailure(cmd, event, fmt.Errorf("read hook payload: %w", err))
	}
	if len(payload) == 0 || len(payload) > maxAgyChatHookPayload || !json.Valid(payload) {
		return agyChatHookFailure(cmd, event, fmt.Errorf("hook payload must be valid JSON under %d bytes", maxAgyChatHookPayload))
	}

	sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
	token := strings.TrimSpace(os.Getenv(agyChatHookTokenEnv))
	if sessionID == "" || token == "" {
		return agyChatHookFailure(cmd, event, fmt.Errorf("Agy Chat hook environment is incomplete"))
	}

	path := "/internal/agy-chat/" + url.PathEscape(sessionID) + "/" + url.PathEscape(event)
	var response map[string]any
	err = ctx.doJSONPathWithHeadersAndTimeout(
		cmd.Context(),
		http.MethodPost,
		path,
		agyChatHookRequest{Payload: json.RawMessage(payload)},
		&response,
		map[string]string{agyChatHookTokenHeader: token},
		61*time.Minute,
	)
	if err != nil {
		return agyChatHookFailure(cmd, event, err)
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(response)
}

// PreToolUse must fail closed: Antigravity expects a valid decision object on
// stdout, and a daemon outage must never turn into implicit permission. For
// PreInvocation there is no deny-shaped response, so returning the error makes
// the turn fail rather than silently dropping AO's system instructions.
func agyChatHookFailure(cmd *cobra.Command, event string, err error) error {
	if event != "pre-tool-use" {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{
		"decision": "deny",
		"reason":   "Agent Orchestrator could not validate this tool call: " + err.Error(),
	})
}
