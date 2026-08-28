// Package portscan answers one question: which TCP ports are these processes
// listening on?
//
// It is best effort by deliberate design. The desktop preview shows detected
// ports as clickable suggestions, so a machine without a usable enumeration
// path (no /proc, no lsof, a permission denial) must yield "nothing detected"
// rather than an error a user has to read and cannot act on. Every entry point
// here therefore returns a possibly-empty slice and no error.
package portscan

import (
	"context"
	"sort"
)

// boundPort is one TCP socket in the LISTEN state and the process that owns it.
type boundPort struct {
	PID  int
	Port int
}

// ownedListeners returns the TCP listening sockets owned by pids, deduplicated: a
// server bound to both 0.0.0.0 and ::1 is one entry, not two. Order is stable
// (port, then pid) so a polling caller does not see the list reshuffle.
func ownedListeners(ctx context.Context, pids []int) []boundPort {
	want := make(map[int]bool, len(pids))
	for _, pid := range pids {
		if pid > 0 {
			want[pid] = true
		}
	}
	if len(want) == 0 {
		return nil
	}
	return dedupe(listeners(ctx, want))
}

func dedupe(found []boundPort) []boundPort {
	if len(found) == 0 {
		return nil
	}
	seen := make(map[boundPort]bool, len(found))
	out := make([]boundPort, 0, len(found))
	for _, entry := range found {
		if seen[entry] {
			continue
		}
		seen[entry] = true
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		return out[i].PID < out[j].PID
	})
	return out
}
