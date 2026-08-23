//go:build unix

package sandboxruntime

import (
	"context"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestParseControlPlaneURLRequiresVerifiedTLSShape(t *testing.T) {
	for _, raw := range []string{
		"http://control.example.test",
		"control.example.test",
		"https://user:secret@control.example.test",
		"https://control.example.test?token=nope",
		"https://control.example.test#fragment",
	} {
		if _, err := parseControlPlaneURL(raw); err == nil {
			t.Errorf("parseControlPlaneURL(%q) succeeded", raw)
		}
	}
	got, err := parseControlPlaneURL("https://control.example.test/base/")
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != "https://control.example.test/base" {
		t.Fatalf("URL = %q", got)
	}
}

func TestControlPlaneClientUsesBearerOnlyDuringRequest(t *testing.T) {
	const secret = "opaque-runtime-capability"
	capabilityPath := writeCapability(t, []byte(secret), 0o600)
	var received string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := NewControlPlaneClient(server.URL, uint32(os.Getuid()), roots)
	if err != nil {
		t.Fatal(err)
	}
	client.capabilityPath = capabilityPath

	response, err := client.doAuthenticated(context.Background(), http.MethodPost, "/consume", nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if received != "Bearer "+secret {
		t.Fatalf("Authorization = %q", received)
	}
}

func TestControlPlaneClientDoesNotDisableCertificateVerification(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewControlPlaneClient(server.URL, uint32(os.Getuid()), nil)
	if err != nil {
		t.Fatal(err)
	}
	client.capabilityPath = writeCapability(t, []byte("opaque-runtime-capability"), 0o600)
	if _, err := client.doAuthenticated(context.Background(), http.MethodPost, "/consume", nil); err == nil {
		t.Fatal("request trusted an unknown TLS certificate")
	}
}

func TestControlPlaneClientRedactsReflectedCapability(t *testing.T) {
	const secret = "opaque-runtime-capability"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, r.Header.Get("Authorization"))
	}))
	defer server.Close()

	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := NewControlPlaneClient(server.URL, uint32(os.Getuid()), roots)
	if err != nil {
		t.Fatal(err)
	}
	client.capabilityPath = writeCapability(t, []byte(secret), 0o600)
	_, err = client.doAuthenticated(context.Background(), http.MethodPost, "/consume", nil)
	if err == nil {
		t.Fatal("request succeeded")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked capability: %v", err)
	}
}
