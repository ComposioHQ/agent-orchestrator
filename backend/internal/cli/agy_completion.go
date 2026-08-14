package cli

import (
	"context"
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
)

// relayAgyAfterAgent reports an Agy execution boundary to the project's current
// orchestrator. This is intentionally keyed to Agy's AfterAgent hook rather than
// generic worker-idle state: upstream AO deliberately removed idle nudges because
// idle is not a reliable completion signal. AfterAgent is provider-owned evidence
// that one Agy execution ended, while the message still tells the orchestrator to
// verify the requested task independently instead of treating the provider turn as
// proof of task success.
func (c *commandContext) relayAgyAfterAgent(
	ctx context.Context,
	workerID string,
	conversation hookConversationSnapshot,
) error {
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

	message := formatAgyCompletionMessage(workerID, conversation)
	path := "sessions/" + url.PathEscape(orchestrator.ID) + "/send"
	if err := c.postJSON(ctx, path, sendAPIRequest{Message: message}, nil); err != nil {
		return fmt.Errorf("send completion to orchestrator %s: %w", orchestrator.ID, err)
	}
	return nil
}

// selectAgyCompletionOrchestrator resolves a safe current orchestration target.
// Idle orchestrators are always eligible. An active Codex orchestrator is also
// eligible because the Codex adapter explicitly supports mid-turn steering.
// Waiting/blocked/exited sessions are never written to by an automated hook.
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

func formatAgyCompletionMessage(workerID string, conversation hookConversationSnapshot) string {
	workerID = domain.SanitizeControlChars(strings.TrimSpace(workerID))
	prompt := capHookText(conversation.LatestUserPrompt, maxAgyCompletionPromptLen)
	result := capHookText(conversation.LatestAssistantUpdate, maxAgyCompletionResultLen)

	var msg strings.Builder
	fmt.Fprintf(&msg, "[AO Agy execution] Worker %s reached its AfterAgent execution boundary.\n", workerID)
	msg.WriteString("This means the Agy execution ended; it does not prove the requested task succeeded. Verify the worker's repo/PR/tests and decide whether more work is needed.\n")
	if prompt != "" {
		fmt.Fprintf(&msg, "\nWorker request:\n%s\n", prompt)
	}
	if result != "" {
		fmt.Fprintf(&msg, "\nWorker final response:\n%s\n", result)
	} else {
		msg.WriteString("\nWorker final response: <none reported by Agy>\n")
	}
	return msg.String()
}
