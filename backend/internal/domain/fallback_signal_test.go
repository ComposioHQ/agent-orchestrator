package domain

import (
	"math"
	"testing"
	"time"
)

func TestRateLimitsExhausted(t *testing.T) {
	cases := []struct {
		name   string
		limits ConversationRateLimits
		want   bool
	}{
		{"absent telemetry is not exhaustion", ConversationRateLimits{PrimaryUsedPercent: -1, SecondaryUsedPercent: -1}, false},
		{"partial window below 100", ConversationRateLimits{PrimaryUsedPercent: 71, SecondaryUsedPercent: -1}, false},
		{"primary at 100", ConversationRateLimits{PrimaryUsedPercent: 100, SecondaryUsedPercent: -1}, true},
		{"overshoot past 100 is still exhaustion", ConversationRateLimits{PrimaryUsedPercent: 100.5, SecondaryUsedPercent: -1}, true},
		{"fresh zero usage is not exhaustion", ConversationRateLimits{PrimaryUsedPercent: 0, SecondaryUsedPercent: 0}, false},
		{"NaN telemetry is not exhaustion", ConversationRateLimits{PrimaryUsedPercent: math.NaN(), SecondaryUsedPercent: -1}, false},
		{"secondary at 100", ConversationRateLimits{PrimaryUsedPercent: 40, SecondaryUsedPercent: 100}, true},
		{"worst window wins", ConversationRateLimits{PrimaryUsedPercent: 99.9, SecondaryUsedPercent: 100}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RateLimitsExhausted(tc.limits); got != tc.want {
				t.Fatalf("RateLimitsExhausted(%+v) = %v, want %v", tc.limits, got, tc.want)
			}
		})
	}
}

func TestCodexSnapshotExhausted(t *testing.T) {
	cases := []struct {
		name     string
		snapshot CodexCapacitySnapshot
		want     bool
	}{
		{"unknown is not exhaustion", CodexCapacitySnapshot{State: CodexCapacityUnknown}, false},
		{"available is not exhaustion", CodexCapacitySnapshot{State: CodexCapacityAvailable}, false},
		{"near limit is not exhaustion", CodexCapacitySnapshot{State: CodexCapacityNearLimit}, false},
		{"unsupported is not exhaustion", CodexCapacitySnapshot{State: CodexCapacityUnsupported}, false},
		{"zero value is not exhaustion", CodexCapacitySnapshot{}, false},
		{"exhausted is exhaustion", CodexCapacitySnapshot{State: CodexCapacityExhausted}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CodexSnapshotExhausted(tc.snapshot); got != tc.want {
				t.Fatalf("CodexSnapshotExhausted(state=%q) = %v, want %v", tc.snapshot.State, got, tc.want)
			}
		})
	}
}

func completedTurn() ConversationTurn {
	now := time.Now()
	started := now.Add(-time.Minute)
	return ConversationTurn{State: TurnStateCompleted, StartedAt: &started, CompletedAt: &now}
}

func TestIsZeroOutputStop(t *testing.T) {
	assistant := func(text string) ConversationMessage {
		return ConversationMessage{Role: MessageRoleAssistant, Text: text}
	}
	user := func(text string) ConversationMessage {
		return ConversationMessage{Role: MessageRoleUser, Text: text}
	}
	prodActivity := func(kind ActivityKind) ConversationActivity {
		return ConversationActivity{Kind: kind, Status: ActivityStatusCompleted}
	}

	completed := completedTurn()
	running := ConversationTurn{State: TurnStateRunning, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt}
	noTimestamps := ConversationTurn{State: TurnStateCompleted}

	cases := []struct {
		name       string
		turn       ConversationTurn
		messages   []ConversationMessage
		activities []ConversationActivity
		want       bool
	}{
		{"empty completed turn is zero-output", completed, nil, nil, true},
		{"user text alone is still zero-output", completed, []ConversationMessage{user("hello")}, nil, true},
		{"assistant text is output", completed, []ConversationMessage{assistant("done")}, nil, false},
		{"blank assistant text is not output", completed, []ConversationMessage{assistant("  \n ")}, nil, true},
		{"usage activity alone is not output", completed, nil, []ConversationActivity{{Kind: ActivityKindUsage, Status: ActivityStatusCompleted}}, true},
		{"reasoning alone is not output", completed, nil, []ConversationActivity{{Kind: ActivityKindReasoning, Status: ActivityStatusCompleted}}, true},
		{"error alone is not output", completed, nil, []ConversationActivity{{Kind: ActivityKindError, Status: ActivityStatusFailed}}, true},
		{"approval question alone is not output", completed, nil, []ConversationActivity{{Kind: ActivityKindApproval, Status: ActivityStatusPending}}, true},
		{"failed command still counts as output", completed, nil, []ConversationActivity{{Kind: ActivityKindCommand, Status: ActivityStatusFailed}}, false},
		{"pending command on a completed turn still counts as output", completed, nil, []ConversationActivity{{Kind: ActivityKindCommand, Status: ActivityStatusPending}}, false},
		{"command is output", completed, nil, []ConversationActivity{prodActivity(ActivityKindCommand)}, false},
		{"file change is output", completed, nil, []ConversationActivity{prodActivity(ActivityKindFileChange)}, false},
		{"plan activity is output", completed, nil, []ConversationActivity{prodActivity(ActivityKindPlan)}, false},
		{"mcp tool call is output", completed, nil, []ConversationActivity{prodActivity(ActivityKindMCPTool)}, false},
		{"cancelled command is not output", completed, nil, []ConversationActivity{{Kind: ActivityKindCommand, Status: ActivityStatusCancelled}}, true},
		{
			"turn diff files are output",
			ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt,
				Diff: &ConversationTurnDiff{Files: []ConversationDiffFile{{Path: "a.go", Status: "modified"}}}},
			nil, nil, false,
		},
		{
			"turn plan steps are output",
			ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt,
				Plan: &ConversationPlan{Steps: []ConversationPlanStep{{Text: "x"}}}},
			nil, nil, false,
		},
		{
			"turn plan explanation alone is output",
			ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt,
				Plan: &ConversationPlan{Explanation: "migrate in three steps"}},
			nil, nil, false,
		},
		{
			"empty non-nil diff is not output",
			ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt,
				Diff: &ConversationTurnDiff{}},
			nil, nil, true,
		},
		{
			"empty non-nil plan is not output",
			ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt,
				Plan: &ConversationPlan{}},
			nil, nil, true,
		},
		{"running turn never flags", running, nil, nil, false},
		{"recovered turn never flags", ConversationTurn{State: TurnStateRecovered, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt}, nil, nil, false},
		{"failed turn never flags", ConversationTurn{State: TurnStateFailed, StartedAt: completed.StartedAt, CompletedAt: completed.CompletedAt}, nil, nil, false},
		{"missing timestamps never flags", noTimestamps, nil, nil, false},
		{"started without completion never flags", ConversationTurn{State: TurnStateCompleted, StartedAt: completed.StartedAt}, nil, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsZeroOutputStop(tc.turn, tc.messages, tc.activities); got != tc.want {
				t.Fatalf("IsZeroOutputStop() = %v, want %v", got, tc.want)
			}
		})
	}
}
