// Package muxd is the sandbox's published front door for terminal traffic.
//
// It exists because of one settled architectural decision, recorded where /mux
// is classified in internal/httpd/routescope.go: hosted terminal panes do not
// pass through the control plane. The desktop's main process dials the
// sandbox's own published /mux directly with a one-time ticket. Relaying every
// byte of every pane through the control plane would buy nothing — the ticket
// already scopes and expires the connection — and would put the control plane
// on the latency path of every keystroke.
//
// # Why this is a relay and not a second implementation
//
// The AO daemon already runs inside the sandbox and already serves the real
// /mux on loopback, backed by the same internal/terminal manager and the same
// tmux runtime the desktop uses. This package therefore does NOT reimplement
// the wire protocol. It authenticates the connection and then pumps WebSocket
// messages between the public socket and the daemon's loopback socket verbatim,
// preserving opcode and payload bytes.
//
// That is the whole point. A second implementation of the ch-tagged protocol
// would be a second thing to keep in step with internal/terminal/protocol.go
// and the renderer's client, and the two would drift the first time a frame
// gained a field. Byte-for-byte relaying makes cloud and local the same
// protocol by construction rather than by discipline, and it keeps daemon
// composition (which owns what the daemon serves) entirely out of this package.
//
// # What the listener trusts
//
// Nothing about the network, and nothing about the caller's origin.
//
// TLS terminates at the sandbox provider's edge proxy, which is what publishes
// this listener to the internet; the hop from that proxy to this process is
// plaintext on the provider's internal network. So this listener treats its own
// transport as untrusted and derives every authorization decision from the
// ticket alone. It does not consult Origin, Referer, or source address:
// there are no ambient credentials here (no cookies, no session), so an origin
// check would add no security while breaking the desktop's main process, whose
// Origin is not a meaningful web origin at all.
//
// The corollary is a deployment requirement, not an implementation detail: the
// provider edge MUST be the only route to this port, and the port must not be
// published without TLS in front of it. A ticket presented over plaintext to an
// eavesdropper is a ticket that can be raced.
package muxd
