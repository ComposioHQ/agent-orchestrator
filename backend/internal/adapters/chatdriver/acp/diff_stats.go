package acp

import "strings"

// lineDelta reports how many lines were added and removed between two file
// snapshots. ACP tool diffs send full old/new text, not a unified patch — counting
// each side's length would make a one-line edit in a 1400-line file show as
// +1400 −1400.
func lineDelta(oldText, newText string) (additions, deletions int) {
	if oldText == newText {
		return 0, 0
	}
	oldLines := splitLines(oldText)
	newLines := splitLines(newText)
	if len(oldLines) == 0 {
		return len(newLines), 0
	}
	if len(newLines) == 0 {
		return 0, len(oldLines)
	}
	lcs := longestCommonSubsequenceLen(oldLines, newLines)
	return len(newLines) - lcs, len(oldLines) - lcs
}

func splitLines(value string) []string {
	if value == "" {
		return nil
	}
	lines := strings.Split(value, "\n")
	// A trailing newline marks "file ends with newline", not an extra blank line.
	if strings.HasSuffix(value, "\n") {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// longestCommonSubsequenceLen is a rolling-row LCS length over line tokens.
// Space is O(min(len(a), len(b))); callers already hold both full file bodies.
func longestCommonSubsequenceLen(a, b []string) int {
	if len(a) < len(b) {
		a, b = b, a
	}
	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			if a[i-1] == b[j-1] {
				curr[j] = prev[j-1] + 1
			} else if prev[j] >= curr[j-1] {
				curr[j] = prev[j]
			} else {
				curr[j] = curr[j-1]
			}
		}
		prev, curr = curr, prev
	}
	return prev[len(b)]
}

// turnFileSnap is one path's turn-scoped before/after. ACP emits per-tool
// snapshots, not an aggregated turn diff, so AO has to keep the first old text
// and the latest new text to report net line counts the way Codex's turn diff does.
type turnFileSnap struct {
	path      string
	status    string
	baseOld   string
	latestNew string
	seen      bool
}

func (s *turnFileSnap) apply(path string, oldText *string, newText string) {
	if !s.seen {
		s.seen = true
		s.path = path
		if oldText == nil {
			s.status = "added"
			s.baseOld = ""
		} else {
			s.baseOld = *oldText
			if newText == "" {
				s.status = "deleted"
			} else {
				s.status = "modified"
			}
		}
		s.latestNew = newText
		return
	}
	s.path = path
	s.latestNew = newText
	switch {
	case s.baseOld == "" && s.status == "added":
		// Still a turn-local add, even after further edits.
		if newText == "" {
			s.status = "deleted"
		} else {
			s.status = "added"
		}
	case newText == "":
		s.status = "deleted"
	default:
		s.status = "modified"
	}
}

func (s turnFileSnap) additionsDeletions() (additions, deletions int) {
	return lineDelta(s.baseOld, s.latestNew)
}
