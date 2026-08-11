package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsDeploymentIdentity(t *testing.T) {
	server := New(Options{
		Environment: "staging",
		Release:     "sha-abc123",
	})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("X-AO-Release"); got != "sha-abc123" {
		t.Fatalf("X-AO-Release = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" ||
		body["environment"] != "staging" ||
		body["release"] != "sha-abc123" {
		t.Fatalf("health body = %#v", body)
	}
}
