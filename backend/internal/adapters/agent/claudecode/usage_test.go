package claudecode

import (
	"strings"
	"testing"
)

const twoTurns = `{"type":"user","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-08-14T10:00:00Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":200}}}
{"type":"assistant","timestamp":"2026-08-14T10:00:30Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":80,"cache_creation_input_tokens":0,"cache_read_input_tokens":300}}}
`

func TestParseTurnsExtractsAssistantUsage(t *testing.T) {
	turns, consumed, err := ParseTurns(strings.NewReader(twoTurns))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 {
		t.Fatalf("turns = %d, want 2", len(turns))
	}
	if consumed != int64(len(twoTurns)) {
		t.Fatalf("consumed = %d, want %d (all complete lines)", consumed, len(twoTurns))
	}
	if turns[0].Model != "claude-opus-4-8" || turns[0].InputTokens != 100 || turns[0].CacheReadTokens != 200 || turns[0].CacheWriteTokens != 10 {
		t.Fatalf("turn0 = %+v", turns[0])
	}
}

func TestParseTurnsLeavesPartialTrailingLine(t *testing.T) {
	// A partial (no trailing newline) assistant line must not be consumed, so
	// the next Stop hook re-reads it once complete and never double counts.
	partial := twoTurns + `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":9`
	turns, consumed, err := ParseTurns(strings.NewReader(partial))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 {
		t.Fatalf("turns = %d, want 2 (partial line ignored)", len(turns))
	}
	if consumed != int64(len(twoTurns)) {
		t.Fatalf("consumed = %d, want %d (stop before partial line)", consumed, len(twoTurns))
	}
}

func TestParseTurnsSkipsMalformedAndZeroUsage(t *testing.T) {
	in := `not json
{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"system","message":{}}
`
	turns, _, err := ParseTurns(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 0 {
		t.Fatalf("turns = %d, want 0", len(turns))
	}
}

func TestSummarizePicksPrimaryModelAndSums(t *testing.T) {
	turns, _, _ := ParseTurns(strings.NewReader(twoTurns))
	s := Summarize(turns, 30000)
	if s.TurnCount != 2 {
		t.Fatalf("turnCount = %d, want 2", s.TurnCount)
	}
	if s.InputTokens != 105 || s.OutputTokens != 130 || s.CacheReadTokens != 500 || s.CacheWriteTokens != 10 {
		t.Fatalf("summary tokens = %+v", s)
	}
	if s.Model != "claude-opus-4-8" {
		t.Fatalf("primary model = %q", s.Model)
	}
	if s.DurationMs != 30000 {
		t.Fatalf("duration = %d", s.DurationMs)
	}
}

func TestParseAllReturnsTurnsAndDurationInOnePass(t *testing.T) {
	turns, dur, err := ParseAll(strings.NewReader(twoTurns))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 {
		t.Fatalf("turns = %d, want 2", len(turns))
	}
	if dur != 30000 {
		t.Fatalf("duration = %d, want 30000", dur)
	}
	if _, d, _ := ParseAll(strings.NewReader(`{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"output_tokens":1}}}` + "\n")); d != 0 {
		t.Fatalf("duration without timestamps = %d, want 0", d)
	}
}
