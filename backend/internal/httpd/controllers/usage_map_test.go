package controllers

import "testing"

func TestToTokenUsageClampsNegativesAndSanitizesModel(t *testing.T) {
	got := toTokenUsage(UsageTurn{
		Model:            "  claude-opus-4-8  ",
		InputTokens:      -5,
		OutputTokens:     10,
		CacheReadTokens:  -1,
		CacheWriteTokens: 3,
	})
	if got.Model != "claude-opus-4-8" {
		t.Fatalf("model = %q, want trimmed", got.Model)
	}
	if got.InputTokens != 0 || got.CacheReadTokens != 0 {
		t.Fatalf("negatives not clamped: %+v", got)
	}
	if got.OutputTokens != 10 || got.CacheWriteTokens != 3 {
		t.Fatalf("non-negatives altered: %+v", got)
	}
}
