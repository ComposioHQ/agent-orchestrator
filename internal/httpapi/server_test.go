package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsDeploymentIdentity(t *testing.T) {
	var logs bytes.Buffer
	server := New(Options{
		Environment: "staging",
		Release:     "sha-abc123",
		Logger:      slog.New(slog.NewJSONHandler(&logs, nil)),
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
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("decode request log: %v", err)
	}
	if entry["method"] != http.MethodGet ||
		entry["route"] != "/healthz" ||
		entry["status"] != float64(http.StatusOK) ||
		entry["release"] != "sha-abc123" {
		t.Fatalf("request log = %#v", entry)
	}
}
