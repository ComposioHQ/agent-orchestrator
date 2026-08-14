package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// usageTurnAPI mirrors controllers.UsageTurn. The CLI keeps its own copy so a
// short-lived hook process need not import the httpd controllers.
type usageTurnAPI struct {
	Model            string `json:"model"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
}

type usageSummaryAPI struct {
	usageTurnAPI
	TurnCount  int64 `json:"turnCount"`
	DurationMs int64 `json:"durationMs,omitempty"`
}

type recordUsageAPIRequest struct {
	Turns   []usageTurnAPI   `json:"turns,omitempty"`
	Summary *usageSummaryAPI `json:"summary,omitempty"`
}

// reportUsage parses token usage from a claude-code transcript and reports it
// to the daemon. It runs on the Stop and SessionEnd hooks: Stop flushes the
// turns completed since the last report, SessionEnd flushes any remaining
// turns plus a whole-session summary. Like every hook path it is best-effort:
// a missing transcript, a read error, or an unreachable daemon all return
// quietly so the agent is never disrupted.
//
// Exactly-once-ish accounting: the byte offset consumed so far is persisted per
// (session, transcript) and only advanced after a successful POST, so a failed
// report is retried on the next hook without ever double counting a turn.
func (c *commandContext) reportUsage(ctx context.Context, agent, event, sessionID string, payload []byte) {
	if agent != "claude-code" || (event != "stop" && event != "session-end") {
		return
	}
	transcriptPath := usageTranscriptPath(payload)
	if transcriptPath == "" {
		return
	}
	dataDir := os.Getenv("AO_DATA_DIR")
	if dataDir == "" {
		return
	}

	offset := readUsageOffset(dataDir, sessionID, transcriptPath)
	f, err := os.Open(transcriptPath) //nolint:gosec // path from a trusted local hook payload; read-only.
	if err != nil {
		c.reportHookFailure(agent, event, sessionID, err)
		return
	}
	defer func() { _ = f.Close() }()
	if info, statErr := f.Stat(); statErr == nil && info.Size() < offset {
		offset = 0 // transcript was rotated/truncated; re-read from the start.
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		offset = 0
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return
		}
	}
	turns, consumed, err := claudecode.ParseTurns(f)
	if err != nil {
		c.reportHookFailure(agent, event, sessionID, err)
		return
	}

	req := recordUsageAPIRequest{}
	for _, t := range turns {
		req.Turns = append(req.Turns, toUsageTurnAPI(t))
	}
	if event == "session-end" {
		if s, ok := wholeSessionSummary(transcriptPath); ok {
			req.Summary = &s
		}
	}
	if len(req.Turns) == 0 && req.Summary == nil {
		return
	}

	path := "sessions/" + url.PathEscape(sessionID) + "/usage"
	if err := c.postJSON(ctx, path, req, nil); err != nil {
		c.reportHookFailure(agent, event, sessionID, err)
		return // leave the offset unadvanced so these turns retry next hook.
	}
	writeUsageOffset(dataDir, sessionID, transcriptPath, offset+consumed)
}

// wholeSessionSummary reads the full transcript once and rolls it into a
// summary (turns plus wall-clock duration in a single pass).
func wholeSessionSummary(transcriptPath string) (usageSummaryAPI, bool) {
	f, err := os.Open(transcriptPath) //nolint:gosec // path from a trusted local hook payload; read-only.
	if err != nil {
		return usageSummaryAPI{}, false
	}
	defer func() { _ = f.Close() }()
	all, dur, err := claudecode.ParseAll(f)
	if err != nil || len(all) == 0 {
		return usageSummaryAPI{}, false
	}
	s := claudecode.Summarize(all, dur)
	return usageSummaryAPI{
		usageTurnAPI: toUsageTurnAPI(s.TokenUsage),
		TurnCount:    s.TurnCount,
		DurationMs:   s.DurationMs,
	}, true
}

func toUsageTurnAPI(t ports.TokenUsage) usageTurnAPI {
	return usageTurnAPI{
		Model:            t.Model,
		InputTokens:      t.InputTokens,
		OutputTokens:     t.OutputTokens,
		CacheReadTokens:  t.CacheReadTokens,
		CacheWriteTokens: t.CacheWriteTokens,
	}
}

func usageTranscriptPath(payload []byte) string {
	var p struct {
		TranscriptPath string `json:"transcript_path"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.TranscriptPath
}

// usageOffsetPath is where the consumed-byte offset for one (session,
// transcript) pair lives. The transcript path is hashed so an arbitrary
// filesystem path never becomes a directory component.
func usageOffsetPath(dataDir, sessionID, transcriptPath string) string {
	sum := sha256.Sum256([]byte(transcriptPath))
	return filepath.Join(dataDir, "usage", sessionID, hex.EncodeToString(sum[:8])+".offset")
}

func readUsageOffset(dataDir, sessionID, transcriptPath string) int64 {
	data, err := os.ReadFile(usageOffsetPath(dataDir, sessionID, transcriptPath))
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(string(data), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func writeUsageOffset(dataDir, sessionID, transcriptPath string, offset int64) {
	p := usageOffsetPath(dataDir, sessionID, transcriptPath)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(p, []byte(strconv.FormatInt(offset, 10)), 0o600)
}
