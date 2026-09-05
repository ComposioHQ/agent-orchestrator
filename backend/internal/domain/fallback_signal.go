package domain

import "strings"

// QuotaExhaustedUsedPercent is the usage percentage that counts as exhausted.
const QuotaExhaustedUsedPercent = 100.0

// RateLimitsExhausted reports whether quota telemetry shows a fully consumed
// window. Absent telemetry is not exhaustion; callers must gate on freshness.
func RateLimitsExhausted(l ConversationRateLimits) bool {
	return l.WorstUsedPercent() >= QuotaExhaustedUsedPercent
}

// CodexSnapshotExhausted reports whether a derived Codex capacity snapshot is
// exhausted, reusing the coordinator's State instead of re-deriving the rule.
func CodexSnapshotExhausted(s CodexCapacitySnapshot) bool {
	return s.State == CodexCapacityExhausted
}

// IsZeroOutputStop reports whether a completed turn produced no assistant
// output: no assistant text, diff files, plan content, or non-cancelled
// production activity (command, file_change, plan, mcp_tool). Anything
// uncertain (other states, missing timestamps) reports false.
func IsZeroOutputStop(
	turn ConversationTurn,
	messages []ConversationMessage,
	activities []ConversationActivity,
) bool {
	if turn.State != TurnStateCompleted {
		return false
	}
	if turn.StartedAt == nil || turn.CompletedAt == nil {
		return false
	}
	for _, m := range messages {
		if m.Role == MessageRoleAssistant && strings.TrimSpace(m.Text) != "" {
			return false
		}
	}
	if turn.Diff != nil && len(turn.Diff.Files) > 0 {
		return false
	}
	if turn.Plan != nil && (strings.TrimSpace(turn.Plan.Explanation) != "" || len(turn.Plan.Steps) > 0) {
		return false
	}
	for _, a := range activities {
		switch a.Kind {
		case ActivityKindCommand, ActivityKindFileChange, ActivityKindPlan, ActivityKindMCPTool:
			if a.Status != ActivityStatusCancelled {
				return false
			}
		}
	}
	return true
}
