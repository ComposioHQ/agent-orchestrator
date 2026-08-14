package ports

// TokenUsage is the token consumption of a single agent model turn.
type TokenUsage struct {
	Model            string
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

// UsageSummary is a whole-session rollup emitted once when a session ends.
// The embedded TokenUsage carries the summed token counts and the primary
// (most-used) model.
type UsageSummary struct {
	TokenUsage
	TurnCount  int64
	DurationMs int64
}

// UsageReport is what an agent hook reports for a session: zero or more
// completed turns (each becomes a per-turn telemetry event) and, on session
// end, an optional whole-session summary.
type UsageReport struct {
	Turns   []TokenUsage
	Summary *UsageSummary
}

// HasData reports whether the report carries anything worth recording.
func (r UsageReport) HasData() bool {
	return len(r.Turns) > 0 || r.Summary != nil
}
