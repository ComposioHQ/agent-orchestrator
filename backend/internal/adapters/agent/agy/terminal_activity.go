package agy

import (
	"regexp"
	"strings"
)

var agyTerminalEscape = regexp.MustCompile(`\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07]*(?:\x07|\x1b\\))`)

// TerminalAwaitingDecision reports a blocked Agy permission picker only when
// several structural markers are present together. Agy's hooks do not expose
// permission-wait events, so terminal output is the only just-in-time signal
// available before Send writes a message and its trailing Enter into the TUI.
func (p *Plugin) TerminalAwaitingDecision(output string) bool {
	plain := agyTerminalEscape.ReplaceAllString(strings.ReplaceAll(output, "\r", "\n"), "")
	lines := strings.Split(plain, "\n")
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	plain = strings.ToLower(strings.Join(lines, "\n"))
	if strings.Contains(plain, "requesting permission for:") &&
		strings.Contains(plain, "do you want to proceed?") &&
		strings.Contains(plain, "1. yes") &&
		strings.Contains(plain, "3. no") {
		return true
	}
	return false
}
