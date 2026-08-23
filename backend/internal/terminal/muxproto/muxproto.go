// Package muxproto holds the wire contract for the terminal multiplex
// handshake: the reserved path, the protocol subprotocol, and the ticket
// subprotocol that authenticates a connection to a sandbox's published
// listener.
//
// The path is reserved as /mux on both listeners a client can reach — the
// local daemon's loopback listener and a sandbox's published listener — so the
// desktop speaks one path and one JSON frame contract regardless of which
// plane a session lives on. What differs is only which listener answers and
// whether a ticket is required. The control plane's own /mux is never exposed
// publicly; it is the local daemon's route and stays that way (see the /mux
// entry in internal/httpd's route classification).
//
// The ticket travels as a WebSocket subprotocol, never as a query parameter.
// That is not stylistic. A URL carrying a credential is logged by proxies and
// access logs, lands in referrer headers, and survives in shell history and
// crash reports; Sec-WebSocket-Protocol does none of that. Giving the ticket a
// typed home here — rather than leaving callers to assemble header values by
// hand — is what keeps that property from depending on everyone remembering
// it.
package muxproto

import (
	"errors"
	"strings"
)

// Subprotocol identifies the terminal multiplex frame contract. A client
// offers it; a listener that speaks this contract selects it.
const Subprotocol = "ao.mux.v1"

// ticketPrefix namespaces the one-time connection ticket. The remainder of the
// token is opaque to everything but the issuer.
const ticketPrefix = "ao.ticket."

// ErrNoTicket reports that no ticket subprotocol was offered.
var ErrNoTicket = errors.New("muxproto: no ao.ticket subprotocol offered")

// ErrAmbiguousTicket reports that more than one ticket subprotocol was
// offered. Two credentials in one handshake have no correct interpretation:
// picking either would let a caller smuggle a second identity past whichever
// one the listener logged, so this is refused rather than resolved.
var ErrAmbiguousTicket = errors.New("muxproto: more than one ao.ticket subprotocol offered")

// TicketSubprotocol renders a one-time ticket as its subprotocol token.
//
// It rejects a ticket that cannot appear in a Sec-WebSocket-Protocol header.
// An invalid ticket silently rendered would produce a malformed handshake that
// fails far from its cause — most likely read as "the sandbox is unreachable"
// rather than "the ticket was malformed".
func TicketSubprotocol(ticket string) (string, error) {
	if ticket == "" {
		return "", errors.New("muxproto: ticket is empty")
	}
	if !validToken(ticket) {
		// Never echo the credential into an error: handshake failures commonly
		// reach logs, and a malformed ticket is still a secret until it expires.
		return "", errors.New("muxproto: ticket is not a valid subprotocol token")
	}
	return ticketPrefix + ticket, nil
}

// Offer returns the subprotocols a client presents when opening a terminal
// connection: the frame contract, plus the ticket when one is required. An
// empty ticket yields the frame contract alone, which is what the local daemon
// expects — a loopback listener has no ticket to check.
func Offer(ticket string) ([]string, error) {
	if ticket == "" {
		return []string{Subprotocol}, nil
	}
	token, err := TicketSubprotocol(ticket)
	if err != nil {
		return nil, err
	}
	return []string{Subprotocol, token}, nil
}

// Ticket extracts the one-time ticket from the subprotocols a client offered.
// A listener that requires a ticket calls this instead of reading the URL.
func Ticket(offered []string) (string, error) {
	found := ""
	for _, protocol := range offered {
		value, ok := strings.CutPrefix(strings.TrimSpace(protocol), ticketPrefix)
		if !ok || value == "" {
			continue
		}
		if found != "" {
			return "", ErrAmbiguousTicket
		}
		found = value
	}
	if found == "" {
		return "", ErrNoTicket
	}
	return found, nil
}

// Offered reports whether the client offered the terminal frame contract.
func Offered(offered []string) bool {
	for _, protocol := range offered {
		if strings.TrimSpace(protocol) == Subprotocol {
			return true
		}
	}
	return false
}

// validToken reports whether s is an RFC 7230 token, the grammar a
// Sec-WebSocket-Protocol value must satisfy. Anything outside it — whitespace,
// a comma, a slash — would either split the header into two protocols or make
// it unparseable.
func validToken(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("!#$%&'*+-.^_`|~", r):
		default:
			return false
		}
	}
	return true
}
