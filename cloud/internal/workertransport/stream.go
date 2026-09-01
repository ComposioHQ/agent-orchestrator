package workertransport

// PROTOTYPE (AO_CLOUD_TERMINAL_STREAM=1): persistent duplex terminal stream.
// When Supervisor.StreamDialer is set, every open terminal keeps one duplex
// socket to the control plane: PTY output goes up over it (the control plane
// persists the rows, so replay stays intact) and terminal input frames come
// down over it, bypassing the 100ms transport claim poll for input only. All
// other transport kinds (resize, close, workspace, turns, ...) stay on the
// existing durable poll.

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
)

// TerminalStream is one live duplex socket between this worker and the control
// plane for a single terminal.
type TerminalStream interface {
	// ReadInput blocks until the control plane pushes an input frame.
	ReadInput(ctx context.Context) ([]byte, error)
	// WriteOutput sends one PTY output chunk upstream. A successful write
	// replaces the HTTP output POST (the control plane persists the frame).
	WriteOutput(ctx context.Context, data []byte) error
	Close()
}

// StreamDialer opens a TerminalStream for a terminal. Nil disables streaming.
type StreamDialer func(ctx context.Context, terminalID string) (TerminalStream, error)

// runTerminalStream keeps one duplex stream alive for the lifetime of an open
// terminal, retrying with a small backoff. While connected it exposes the
// stream to copyTerminalOutput (direct output) and writes pushed input frames
// straight into the PTY.
func (s *Supervisor) runTerminalStream(
	ctx context.Context,
	terminalID string,
	process *terminalProcess,
) {
	for ctx.Err() == nil {
		stream, err := s.StreamDialer(ctx, terminalID)
		if err != nil {
			if ctx.Err() == nil {
				s.Logger.Warn("dial terminal stream", "error", err, "terminal_id", terminalID)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		s.Logger.Info("terminal stream connected", "terminal_id", terminalID)
		process.setStream(stream)
		for {
			data, err := stream.ReadInput(ctx)
			if err != nil {
				break
			}
			if len(data) == 0 {
				continue
			}
			if terminalID == s.AgentTerminalID {
				err = s.writeAgentPrompt(terminalID, data)
			} else {
				err = s.writeTerminal(worker.TerminalCommand{TerminalID: terminalID, Data: data})
			}
			if err != nil {
				s.Logger.Warn("terminal stream input write", "error", err, "terminal_id", terminalID)
			}
		}
		process.setStream(nil)
		stream.Close()
	}
}
