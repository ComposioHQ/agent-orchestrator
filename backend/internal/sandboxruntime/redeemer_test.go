package sandboxruntime

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestRedeemerUsesFixedConsumePathAndRereadsCapability(t *testing.T) {
	capabilityPath := filepath.Join(t.TempDir(), "capability")
	writeCapability := func(value string) {
		t.Helper()
		if err := os.WriteFile(capabilityPath, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeCapability("first-capability")
	target := testTarget()
	redeemer, err := NewControlPlaneRedeemer(
		"https://control.example/ignored?secret=no",
		FileCapability{Path: capabilityPath},
		target,
	)
	if err != nil {
		t.Fatal(err)
	}
	wantCapabilities := []string{"Bearer first-capability", "Bearer second-capability"}
	wantTickets := []string{"first-ticket", "second-ticket"}
	calls := 0
	redeemer.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != terminalTicketConsumePath || request.URL.RawQuery != "" {
			t.Fatalf("redemption URL = %s", request.URL.String())
		}
		if got := request.Header.Get("Authorization"); got != wantCapabilities[calls] {
			t.Fatalf("authorization = %q, want %q", got, wantCapabilities[calls])
		}
		var body redemptionRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Ticket != wantTickets[calls] || strings.Contains(request.Header.Get("Authorization"), body.Ticket) {
			t.Fatalf("ticket transport = body:%q authorization:%q", body.Ticket, request.Header.Get("Authorization"))
		}
		calls++
		raw, err := json.Marshal(grantFor(target, ScopeTerminalRead))
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
	})
	if _, err := redeemer.Redeem(context.Background(), wantTickets[0]); err != nil {
		t.Fatal(err)
	}
	writeCapability("second-capability")
	if _, err := redeemer.Redeem(context.Background(), wantTickets[1]); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("redemption calls = %d", calls)
	}
}

func TestRedeemerTransportNeverSkipsTLSVerification(t *testing.T) {
	redeemer, err := NewControlPlaneRedeemer("https://control.example", FileCapability{Path: "/unused"}, testTarget())
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := redeemer.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T", redeemer.client.Transport)
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("control-plane transport enables InsecureSkipVerify")
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.MinVersion != 0 && transport.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatalf("minimum TLS version = %d", transport.TLSClientConfig.MinVersion)
	}
}
