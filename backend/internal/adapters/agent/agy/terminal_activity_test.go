package agy

import "testing"

func TestDetectTerminalActivity(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   bool
	}{
		{
			name: "permission picker",
			output: `Command
Requesting permission for:
git status
Do you want to proceed?
> 1. Yes
  2. Yes, and don't ask again
  3. No`,
			want: true,
		},
		{
			name:   "permission picker with ansi",
			output: "\x1b[1mCommand\x1b[0m\nRequesting permission for:\napply_patch\nDo you want to proceed?\n\x1b[36m> 1. Yes\x1b[0m\n  3. No\n",
			want:   true,
		},
		{name: "ordinary composer", output: "> continue\nGemini 3.7 Flash · high\n"},
		{
			name: "stale permission picker outside terminal tail",
			output: `Requesting permission for:
git status
Do you want to proceed?
> 1. Yes
  3. No
line 01
line 02
line 03
line 04
line 05
line 06
line 07
line 08
line 09
line 10
line 11
line 12
line 13
line 14
line 15
line 16
line 17
line 18
line 19
line 20
> current composer`,
		},
		{name: "assistant prose", output: "The docs ask: Do you want to proceed?\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := (&Plugin{}).TerminalAwaitingDecision(tt.output)
			if got != tt.want {
				t.Fatalf("TerminalAwaitingDecision() = %v, want %v", got, tt.want)
			}
		})
	}
}
