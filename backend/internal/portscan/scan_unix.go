//go:build !linux && !windows

package portscan

import (
	"context"
	"sort"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// lsofTimeout bounds the scan. lsof can stall on an unresponsive mount, and a
// stalled suggestion list must never hold a preview request open.
const lsofTimeout = 2 * time.Second

// listeners shells out to lsof. macOS has no /proc, and its supported
// alternatives (Endpoint Security, DTrace) need root or a special entitlement,
// so a short-lived lsof per scan is the only unprivileged path.
func listeners(ctx context.Context, want map[int]bool) []boundPort {
	pids := make([]int, 0, len(want))
	for pid := range want {
		pids = append(pids, pid)
	}
	sort.Ints(pids)

	scanCtx, cancel := context.WithTimeout(ctx, lsofTimeout)
	defer cancel()
	// lsof exits non-zero when nothing matched, with valid (often empty)
	// stdout, so the output is parsed whenever there is any.
	out, err := aoprocess.CommandContext(scanCtx, "lsof", lsofArgs(pids)...).Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseLsof(string(out), want)
}
