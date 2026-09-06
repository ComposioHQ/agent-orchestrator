package acp

import (
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// lineDelta reports how many lines were added and removed between two texts.
// ACP tool diffs send old/new snapshots (sometimes a hunk, sometimes a wider
// view of the same edit), not a unified patch — counting each side's length
// would make a one-line edit in an N-line file show as +N −N.
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
// Space is O(min(len(a), len(b))); callers already hold both texts.
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

func diffFileFromSnapshot(path string, oldText *string, newText string) ports.ChatDiffFile {
	old := ""
	status := "modified"
	if oldText == nil {
		status = "added"
	} else {
		old = *oldText
		if newText == "" {
			status = "deleted"
		}
	}
	additions, deletions := lineDelta(old, newText)
	return ports.ChatDiffFile{
		Path:      path,
		Status:    status,
		Additions: additions,
		Deletions: deletions,
	}
}

// turnDiffAccumulator stores each tool call's latest file contribution for the
// active turn. ACP re-sends a tool call with expanded old/new context as the
// edit settles; those updates must replace that tool's contribution, not be
// combined with an earlier narrower snapshot (first-old + latest-new).
type turnDiffAccumulator struct {
	toolOrder []string
	byTool    map[string][]ports.ChatDiffFile
}

func (a *turnDiffAccumulator) replaceTool(toolID string, files []ports.ChatDiffFile) {
	if a.byTool == nil {
		a.byTool = make(map[string][]ports.ChatDiffFile)
	}
	if _, exists := a.byTool[toolID]; !exists {
		a.toolOrder = append(a.toolOrder, toolID)
	}
	a.byTool[toolID] = files
}

func (a *turnDiffAccumulator) aggregate() []ports.ChatDiffFile {
	if len(a.byTool) == 0 {
		return nil
	}
	type agg struct {
		path                 string
		status               string
		additions, deletions int
	}
	byPath := make(map[string]*agg)
	var pathOrder []string
	for _, toolID := range a.toolOrder {
		for _, file := range a.byTool[toolID] {
			cur := byPath[file.Path]
			if cur == nil {
				cur = &agg{path: file.Path}
				byPath[file.Path] = cur
				pathOrder = append(pathOrder, file.Path)
			}
			cur.additions += file.Additions
			cur.deletions += file.Deletions
			cur.status = file.Status
		}
	}
	out := make([]ports.ChatDiffFile, 0, len(pathOrder))
	for _, path := range pathOrder {
		cur := byPath[path]
		out = append(out, ports.ChatDiffFile{
			Path:      cur.path,
			Status:    cur.status,
			Additions: cur.additions,
			Deletions: cur.deletions,
		})
	}
	return out
}
