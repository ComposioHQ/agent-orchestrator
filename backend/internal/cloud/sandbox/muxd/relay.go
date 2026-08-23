package muxd

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/coder/websocket"
)

// relay pumps messages between the published socket and the daemon's loopback
// mux until either side goes away.
//
// Messages are forwarded with their opcode and payload untouched. Nothing here
// parses a frame, and nothing should ever start to: the moment this code
// understands the ch-tagged protocol it becomes a second implementation of it,
// and the cloud transport starts drifting from the local one. Everything the
// protocol means is settled in internal/terminal; this is plumbing.
func relay(ctx context.Context, downstream, upstream *websocket.Conn, log *slog.Logger) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Buffered for every producer (both pumps and the heartbeat) so a goroutine
	// that loses the race still exits instead of blocking on a send forever.
	done := make(chan closure, 3)
	go func() { done <- pump(ctx, upstream, downstream, "client") }()
	go func() { done <- pump(ctx, downstream, upstream, "daemon") }()
	go pingLoop(ctx, downstream, done)

	var first closure
	select {
	case first = <-done:
	case <-ctx.Done():
		first = closure{status: websocket.StatusGoingAway, reason: "sandbox listener shutting down"}
	}

	// Close BEFORE cancelling, and in that order. Cancelling the context while a
	// pump is blocked in Read makes coder/websocket tear the socket down
	// abruptly, and the client then sees an unexplained EOF instead of the close
	// status. Sending the close frame first is what lets a client tell "the
	// pane's daemon went away" from "the relay failed" — the difference between
	// reconnecting and surfacing an error.
	_ = downstream.Close(first.status, first.reason)
	_ = upstream.Close(first.status, first.reason)
	cancel()

	if first.err != nil && first.status == websocket.StatusInternalError {
		log.Debug("Sandbox mux relay ended", "error", first.err)
	}
}

// closure is why one direction stopped, translated into what the other side
// should be told.
type closure struct {
	err    error
	status websocket.StatusCode
	reason string
}

// pump copies every message from src to dst verbatim. into names the side being
// written to, and appears only in a close reason.
func pump(ctx context.Context, dst, src *websocket.Conn, into string) closure {
	for {
		typ, payload, err := src.Read(ctx)
		if err != nil {
			return translate(err, into)
		}
		if err := dst.Write(ctx, typ, payload); err != nil {
			return translate(err, into)
		}
	}
}

// translate turns a read/write error into the close the peer should see. A
// clean close on one side is a clean close on the other; anything else is
// reported as an internal error rather than guessing a more specific status.
func translate(err error, into string) closure {
	if status := websocket.CloseStatus(err); status != -1 {
		return closure{err: err, status: status, reason: "peer closed"}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return closure{err: err, status: websocket.StatusGoingAway, reason: "relay cancelled"}
	}
	return closure{err: err, status: websocket.StatusInternalError, reason: "relay to " + into + " failed"}
}

// pingLoop keeps the end-to-end liveness check the local transport has. See the
// heartbeat constant. A failed ping ends the relay through the same path a
// failed pump does, so the close is still a proper handshake.
func pingLoop(ctx context.Context, conn *websocket.Conn, done chan<- closure) {
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, heartbeat)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				done <- closure{err: err, status: websocket.StatusGoingAway, reason: "client stopped answering"}
				return
			}
		}
	}
}
