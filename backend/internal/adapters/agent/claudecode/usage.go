package claudecode

import (
	"bytes"
	"encoding/json"
	"io"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// transcriptLine is the subset of a claude-code transcript JSONL record we
// read. Assistant records carry per-turn token usage under message.usage and
// the model that produced the turn under message.model.
type transcriptLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Model string `json:"model"`
		Usage struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func (l transcriptLine) toUsage() (ports.TokenUsage, bool) {
	if l.Type != "assistant" || l.Message.Model == "" {
		return ports.TokenUsage{}, false
	}
	u := l.Message.Usage
	tu := ports.TokenUsage{
		Model:            l.Message.Model,
		InputTokens:      u.InputTokens,
		OutputTokens:     u.OutputTokens,
		CacheReadTokens:  u.CacheReadInputTokens,
		CacheWriteTokens: u.CacheCreationInputTokens,
	}
	// A record with a model but no token movement at all carries no signal.
	if tu.InputTokens == 0 && tu.OutputTokens == 0 && tu.CacheReadTokens == 0 && tu.CacheWriteTokens == 0 {
		return ports.TokenUsage{}, false
	}
	return tu, true
}

// parseLines scans complete newline-terminated JSONL records, returning the
// assistant turns found, the first/last parseable timestamps across all
// records, and the number of bytes consumed. A trailing partial line (the
// transcript is written concurrently) is left unconsumed. Malformed lines are
// skipped but still consumed.
func parseLines(data []byte) (turns []ports.TokenUsage, first, last time.Time, consumed int64) {
	for {
		nl := bytes.IndexByte(data[consumed:], '\n')
		if nl < 0 {
			break // no terminating newline: the rest is a partial line, leave it.
		}
		line := data[consumed : consumed+int64(nl)]
		consumed += int64(nl) + 1
		var tl transcriptLine
		if json.Unmarshal(bytes.TrimSpace(line), &tl) != nil {
			continue
		}
		if tl.Timestamp != "" {
			if ts, perr := time.Parse(time.RFC3339Nano, tl.Timestamp); perr == nil {
				if first.IsZero() || ts.Before(first) {
					first = ts
				}
				if ts.After(last) {
					last = ts
				}
			}
		}
		if tu, ok := tl.toUsage(); ok {
			turns = append(turns, tu)
		}
	}
	return turns, first, last, consumed
}

// ParseTurns reads assistant-message token usage from a claude-code transcript
// that has been positioned at a byte offset, returning the turns found and the
// number of bytes consumed. Only whole newline-terminated lines are consumed,
// so a trailing partial line is left for the caller's next call (resuming at
// offset+consumed) to re-read once complete. This is what keeps a turn from
// being counted twice across successive Stop hooks.
func ParseTurns(r io.Reader) (turns []ports.TokenUsage, consumed int64, err error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, 0, err
	}
	turns, _, _, consumed = parseLines(data)
	return turns, consumed, nil
}

// ParseAll reads a whole transcript in a single pass, returning every turn and
// the wall-clock duration between its first and last timestamps (0 when
// timestamps are absent). It is used for the session-end summary, replacing a
// second full read of the file.
func ParseAll(r io.Reader) (turns []ports.TokenUsage, durationMs int64, err error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, 0, err
	}
	turns, first, last, _ := parseLines(data)
	if !first.IsZero() && last.After(first) {
		durationMs = last.Sub(first).Milliseconds()
	}
	return turns, durationMs, nil
}

// Summarize rolls a set of turns into a whole-session summary: summed token
// counts, the primary (highest total-token) model, and the turn count. The
// caller supplies the wall-clock duration, which the transcript alone does not
// reliably carry.
func Summarize(turns []ports.TokenUsage, durationMs int64) ports.UsageSummary {
	sum := ports.UsageSummary{TurnCount: int64(len(turns)), DurationMs: durationMs}
	byModel := map[string]int64{}
	var topModel string
	var topTokens int64
	for _, t := range turns {
		sum.InputTokens += t.InputTokens
		sum.OutputTokens += t.OutputTokens
		sum.CacheReadTokens += t.CacheReadTokens
		sum.CacheWriteTokens += t.CacheWriteTokens
		total := t.InputTokens + t.OutputTokens + t.CacheReadTokens + t.CacheWriteTokens
		byModel[t.Model] += total
		if byModel[t.Model] > topTokens {
			topTokens = byModel[t.Model]
			topModel = t.Model
		}
	}
	sum.Model = topModel
	return sum
}
