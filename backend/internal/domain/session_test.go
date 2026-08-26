package domain

import (
	"strings"
	"testing"
)

// TestSessionDisplayNameTooLong pins the cap to a rune budget. A byte budget
// would reject a name well inside the limit as soon as it carried accents,
// emoji, or CJK text, and every boundary (service, HTTP, CLI) shares this one
// check precisely so none of them can drift into counting bytes.
func TestSessionDisplayNameTooLong(t *testing.T) {
	tests := []struct {
		name        string
		displayName string
		want        bool
	}{
		{name: "empty", displayName: "", want: false},
		{name: "short ascii", displayName: "fix login", want: false},
		{name: "ascii at cap", displayName: strings.Repeat("x", MaxSessionDisplayNameLen), want: false},
		{name: "ascii one over cap", displayName: strings.Repeat("x", MaxSessionDisplayNameLen+1), want: true},
		{name: "two-byte runes at cap", displayName: strings.Repeat("é", MaxSessionDisplayNameLen), want: false},
		{name: "two-byte runes one over cap", displayName: strings.Repeat("é", MaxSessionDisplayNameLen+1), want: true},
		{name: "four-byte runes at cap", displayName: strings.Repeat("🚀", MaxSessionDisplayNameLen), want: false},
		{name: "four-byte runes one over cap", displayName: strings.Repeat("🚀", MaxSessionDisplayNameLen+1), want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SessionDisplayNameTooLong(tt.displayName); got != tt.want {
				t.Fatalf("SessionDisplayNameTooLong(%d runes) = %v, want %v", len([]rune(tt.displayName)), got, tt.want)
			}
		})
	}
}
