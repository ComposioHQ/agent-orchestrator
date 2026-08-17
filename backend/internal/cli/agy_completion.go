package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	maxAgyCompletionPromptLen = 2 << 10
	maxAgyCompletionResultLen = 12 << 10
	maxAgyStopErrorLen        = 4 << 10
)

type agyStopOutcome struct {
	ExecutionNum      int
	TerminationReason string
	Error             string
	FullyIdle         *bool
}

func parseAgyStopOutcome(payload []byte) agyStopOutcome {
	var native struct {
		ExecutionNum           int    `json:"executionNum"`
		ExecutionNumSnake      int    `json:"execution_num"`
		TerminationReason      string `json:"terminationReason"`
		TerminationReasonSnake string `json:"termination_reason"`
		Error                  string `json:"error"`
		FullyIdle              *bool  `json:"fullyIdle"`
		FullyIdleSnake         *bool  `json:"fully_idle"`
	}
	_ = json.Unmarshal(payload, &native)
	out := agyStopOutcome{
		ExecutionNum:      native.ExecutionNum,
		TerminationReason: strings.TrimSpace(native.TerminationReason),
		Error:             capHookText(native.Error, maxAgyStopErrorLen),
		FullyIdle:         native.FullyIdle,
	}
	if out.ExecutionNum == 0 {
		out.ExecutionNum = native.ExecutionNumSnake
	}
	if out.TerminationReason == "" {
		out.TerminationReason = strings.TrimSpace(native.TerminationReasonSnake)
	}
	if out.FullyIdle == nil {
		out.FullyIdle = native.FullyIdleSnake
	}
	return out
}

func (o agyStopOutcome) readyForRelay() bool {
	return o.FullyIdle == nil || *o.FullyIdle
}

// relayAgyStop reports the provider-owned Agy Stop execution boundary to the
// project's current orchestrator. Unlike generic worker-idle state, Stop tells
// AO why the provider execution ended. The relay deliberately separates that
// provider outcome from task success: the orchestrator must still verify the
// repo/PR/tests before deciding whether the requested work is complete.
func (c *commandContext) relayAgyStop(
	ctx context.Context,
	workerID string,
	conversation hookConversationSnapshot,
	outcome agyStopOutcome,
) error {
	if !outcome.readyForRelay() {
		return nil
	}
	projectID := strings.TrimSpace(os.Getenv("AO_PROJECT_ID"))
	if projectID == "" {
		return nil
	}

	params := url.Values{}
	params.Set("project", projectID)
	params.Set("active", "true")
	var res sessionListResponse
	if err := c.getJSON(ctx, apiPath("sessions", params), &res); err != nil {
		return fmt.Errorf("list project sessions: %w", err)
	}

	orchestrator, ok := selectAgyCompletionOrchestrator(res.Sessions, workerID)
	if !ok {
		return nil
	}

	message := formatAgyCompletionMessage(workerID, conversation, outcome)
	path := "sessions/" + url.PathEscape(orchestrator.ID) + "/send"
	if err := c.postJSON(ctx, path, sendAPIRequest{Message: message}, nil); err != nil {
		return fmt.Errorf("send completion to orchestrator %s: %w", orchestrator.ID, err)
	}
	return nil
}

// selectAgyCompletionOrchestrator resolves a safe current orchestration target.
// Idle orchestrators are always eligible. An active Codex orchestrator is also
// eligible because the Codex adapter explicitly supports mid-turn steering.
// Waiting/blocked/exited sessions are never selected by this automated hook.
func selectAgyCompletionOrchestrator(sessions []sessionDTO, workerID string) (sessionDTO, bool) {
	candidates := make([]sessionDTO, 0, 1)
	for _, session := range sessions {
		if session.ID == workerID || session.Kind != string(domain.KindOrchestrator) || session.IsTerminated {
			continue
		}
		switch session.Activity.State {
		case string(domain.ActivityIdle):
			candidates = append(candidates, session)
		case string(domain.ActivityActive):
			if domain.AgentHarness(session.Harness) == domain.HarnessCodex {
				candidates = append(candidates, session)
			}
		}
	}
	if len(candidates) == 0 {
		return sessionDTO{}, false
	}

	// A project normally has one active orchestrator. If stale rows coexist,
	// prefer the most recently updated one, then ID for deterministic tests.
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].UpdatedAt.Equal(candidates[j].UpdatedAt) {
			return candidates[i].UpdatedAt.After(candidates[j].UpdatedAt)
		}
		return candidates[i].ID < candidates[j].ID
	})
	return candidates[0], true
}

func formatAgyCompletionMessage(workerID string, conversation hookConversationSnapshot, outcome agyStopOutcome) string {
	workerID = domain.SanitizeControlChars(strings.TrimSpace(workerID))
	prompt := capHookText(conversation.LatestUserPrompt, maxAgyCompletionPromptLen)
	result := capHookText(conversation.LatestAssistantUpdate, maxAgyCompletionResultLen)
	reason := domain.SanitizeControlChars(strings.TrimSpace(outcome.TerminationReason))

	var msg strings.Builder
	fmt.Fprintf(&msg, "[AO Agy execution] Worker %s reached its native Stop execution boundary.\n", workerID)
	msg.WriteString("This reports the provider execution outcome; it does not prove the requested task succeeded. Verify the worker's repo/PR/tests and decide whether more work is needed.\n")
	if outcome.ExecutionNum != 0 {
		fmt.Fprintf(&msg, "\nExecution: %d\n", outcome.ExecutionNum)
	}
	if reason != "" {
		fmt.Fprintf(&msg, "Provider termination: %s\n", reason)
	}
	if outcome.Error != "" {
		fmt.Fprintf(&msg, "Provider error: %s\n", outcome.Error)
	}
	if outcome.FullyIdle != nil {
		fmt.Fprintf(&msg, "Provider fully idle: %t\n", *outcome.FullyIdle)
	}
	if prompt != "" {
		fmt.Fprintf(&msg, "\nWorker request:\n%s\n", prompt)
	}
	if result != "" {
		fmt.Fprintf(&msg, "\nWorker final response:\n%s\n", result)
	} else {
		msg.WriteString("\nWorker final response: <not included in Agy Stop payload; verify durable workspace state>\n")
	}
	return msg.String()
}
