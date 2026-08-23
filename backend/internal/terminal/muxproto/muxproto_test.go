package muxproto_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

func TestOfferCarriesFrameContractAndTicket(t *testing.T) {
	offered, err := muxproto.Offer("t0p-53cr3t")
	if err != nil {
		t.Fatal(err)
	}
	if len(offered) != 2 || offered[0] != muxproto.Subprotocol {
		t.Fatalf("offer = %v, want the frame contract first", offered)
	}
	if !muxproto.Offered(offered) {
		t.Error("offer does not advertise the frame contract")
	}
	ticket, err := muxproto.Ticket(offered)
	if err != nil {
		t.Fatal(err)
	}
	if ticket != "t0p-53cr3t" {
		t.Fatalf("ticket = %q, want the value that went in", ticket)
	}
}

// The local daemon's loopback listener has no ticket to check, and the client
// must be able to speak the same contract to it.
func TestOfferWithoutTicketIsFrameContractAlone(t *testing.T) {
	offered, err := muxproto.Offer("")
	if err != nil {
		t.Fatal(err)
	}
	if len(offered) != 1 || offered[0] != muxproto.Subprotocol {
		t.Fatalf("offer = %v, want just the frame contract", offered)
	}
	if _, err := muxproto.Ticket(offered); !errors.Is(err, muxproto.ErrNoTicket) {
		t.Fatalf("Ticket error = %v, want ErrNoTicket", err)
	}
}

// A ticket that cannot appear in a Sec-WebSocket-Protocol header must be
// caught where it is rendered. Rendered anyway, it would produce a malformed
// handshake that fails far from its cause — read as "the sandbox is
// unreachable" rather than "the ticket was malformed".
func TestTicketSubprotocolRejectsUnsendableTickets(t *testing.T) {
	for name, ticket := range map[string]string{
		"empty":        "",
		"space":        "two words",
		"comma":        "a,b",
		"slash":        "a/b",
		"tab":          "a\tb",
		"newline":      "a\nb",
		"header break": "a\r\nX-Evil: 1",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := muxproto.TicketSubprotocol(ticket); err == nil {
				t.Fatalf("ticket %q was accepted", ticket)
			}
			if _, err := muxproto.Offer(ticket); ticket != "" && err == nil {
				t.Fatalf("Offer accepted ticket %q", ticket)
			}
		})
	}
}

// Two credentials in one handshake have no correct interpretation: picking
// either would let a caller smuggle a second identity past whichever one the
// listener logged.
func TestTicketRefusesAmbiguousOffers(t *testing.T) {
	offered := []string{muxproto.Subprotocol, "ao.ticket.first", "ao.ticket.second"}
	if _, err := muxproto.Ticket(offered); !errors.Is(err, muxproto.ErrAmbiguousTicket) {
		t.Fatalf("Ticket error = %v, want ErrAmbiguousTicket", err)
	}
}

func TestTicketIgnoresUnrelatedSubprotocols(t *testing.T) {
	offered := []string{"chat", muxproto.Subprotocol, "ao.ticket.", "ao.ticketing.thing", "ao.ticket.real"}
	ticket, err := muxproto.Ticket(offered)
	if err != nil {
		t.Fatal(err)
	}
	if ticket != "real" {
		t.Fatalf("ticket = %q, want real", ticket)
	}
}

// The contract's reason for existing: a ticket rendered into the handshake
// never reaches the request URL, so it cannot leak through proxy logs, access
// logs, referrer headers or shell history the way a query parameter does.
func TestTicketTravelsInTheHandshakeNotTheURL(t *testing.T) {
	offered, err := muxproto.Offer("t0p-53cr3t")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://sandbox.example/mux", nil)
	req.Header.Set("Sec-WebSocket-Protocol", strings.Join(offered, ", "))

	if strings.Contains(req.URL.String(), "t0p-53cr3t") {
		t.Fatalf("ticket leaked into the request URL: %s", req.URL.String())
	}
	if req.URL.RawQuery != "" {
		t.Fatalf("handshake carries a query string: %q", req.URL.RawQuery)
	}

	roundTripped, err := muxproto.Ticket(req.Header.Values("Sec-WebSocket-Protocol"))
	if err == nil && roundTripped == "t0p-53cr3t" {
		return
	}
	// Go splits a comma-joined header only when asked; parse the way a server does.
	roundTripped, err = muxproto.Ticket(strings.Split(req.Header.Get("Sec-WebSocket-Protocol"), ","))
	if err != nil {
		t.Fatal(err)
	}
	if roundTripped != "t0p-53cr3t" {
		t.Fatalf("ticket = %q, want the value that went in", roundTripped)
	}
}
