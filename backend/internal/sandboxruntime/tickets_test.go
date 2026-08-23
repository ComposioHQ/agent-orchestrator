//go:build unix

package sandboxruntime

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
)

func TestControlPlaneTicketConsumerUsesPublicAuthenticatedAtomicRoute(t *testing.T) {
	const (
		capability = "opaque-runtime-capability"
		route      = "/api/cloud/v1/test-ticket-consume"
	)
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != route || r.Header.Get("Authorization") != "Bearer "+capability || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("request = %s %s auth=%q type=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Ticket, SandboxID, WorkspaceID, SessionID, Operation string
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.Ticket != "one-time-ticket" || body.SandboxID != "sandbox-1" || body.WorkspaceID != "workspace-1" ||
			body.SessionID != "session-1" || body.Operation != string(OperationWorkspaceFile) {
			t.Errorf("body = %#v", body)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if calls.Add(1) > 1 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := NewControlPlaneClient(server.URL, uint32(os.Getuid()), roots)
	if err != nil {
		t.Fatal(err)
	}
	client.capabilityPath = writeCapability(t, []byte(capability), 0o600)
	consumer, err := newControlPlaneTicketConsumer(client, route, "sandbox-1", "workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := consumer.Consume(context.Background(), "one-time-ticket", OperationWorkspaceFile); err != nil {
		t.Fatal(err)
	}
	if err := consumer.Consume(context.Background(), "one-time-ticket", OperationWorkspaceFile); err == nil {
		t.Fatal("atomic replay succeeded")
	}
}

func TestControlPlaneTicketConsumerRefusesInternalRoute(t *testing.T) {
	client := &ControlPlaneClient{}
	if _, err := newControlPlaneTicketConsumer(client, "/api/internal/sandbox-tickets/redeem", "sandbox-1", "workspace-1", "session-1"); err == nil {
		t.Fatal("rejected internal route was accepted")
	}
}
