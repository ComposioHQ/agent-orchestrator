package controllers_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	projectcontrolsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/projectcontrol"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func newProjectControlServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := sqlitetest.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	projects := projectsvc.New(store)
	id := "demo"
	if _, err := projects.Add(context.Background(), projectsvc.AddInput{Path: gitRepo(t, id), ProjectID: &id}); err != nil {
		t.Fatalf("add project: %v", err)
	}
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, httpd.APIDeps{
		Projects: projects, ProjectControl: projectcontrolsvc.New(store),
	}, httpd.ControlDeps{})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return srv
}

func TestProjectControlAPI_UnconfiguredAndProjectNotFound(t *testing.T) {
	srv := newProjectControlServer(t)
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/projects/demo/control", "")
	if status != http.StatusOK {
		t.Fatalf("GET control = %d, want 200; body=%s", status, body)
	}
	var got domain.ProjectControl
	mustJSON(t, body, &got)
	want := domain.UnconfiguredProjectControl("demo")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("control = %#v, want %#v", got, want)
	}

	body, status, _ = doRequest(t, srv, http.MethodGet, "/api/v1/projects/missing/control", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "PROJECT_NOT_FOUND")
}

func TestProjectControlAPI_SetStableIDsRetryAndConflict(t *testing.T) {
	srv := newProjectControlServer(t)
	create := `{"statement":"Ship slice one","criteria":[{"statement":"API passes","verificationMethod":"go test","displayOrder":1},{"statement":"CLI passes","verificationMethod":"CLI integration test","displayOrder":0}],"expectedRevision":0,"idempotencyKey":"create-1"}`
	body, status, _ := doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", create)
	if status != http.StatusOK {
		t.Fatalf("PUT outcome = %d, want 200; body=%s", status, body)
	}
	var first domain.ProjectControl
	mustJSON(t, body, &first)
	if first.Revision != 1 || first.Outcome == nil || len(first.Outcome.Criteria) != 2 {
		t.Fatalf("created control = %#v", first)
	}
	if first.Outcome.Criteria[0].DisplayOrder != 0 || first.Outcome.Criteria[1].DisplayOrder != 1 {
		t.Fatalf("criteria not ordered: %#v", first.Outcome.Criteria)
	}

	retryBody, retryStatus, _ := doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", create)
	if retryStatus != http.StatusOK || string(retryBody) != string(body) {
		t.Fatalf("idempotent retry = %d %s, want exact original %s", retryStatus, retryBody, body)
	}

	updatePayload := map[string]any{
		"statement": "Ship slice one safely", "expectedRevision": 1, "idempotencyKey": "update-1",
		"criteria": []map[string]any{
			{"id": first.Outcome.Criteria[1].ID, "statement": "API passes", "verificationMethod": "go test ./internal/httpd/...", "displayOrder": 0},
			{"id": first.Outcome.Criteria[0].ID, "statement": "CLI passes", "verificationMethod": "go test ./internal/cli", "displayOrder": 1},
		},
	}
	encoded, _ := json.Marshal(updatePayload)
	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", string(encoded))
	if status != http.StatusOK {
		t.Fatalf("PUT update = %d, want 200; body=%s", status, body)
	}
	var updated domain.ProjectControl
	mustJSON(t, body, &updated)
	if updated.Revision != 2 || updated.Outcome.Criteria[0].ID != first.Outcome.Criteria[1].ID || updated.Outcome.Criteria[1].ID != first.Outcome.Criteria[0].ID {
		t.Fatalf("stable criterion ids not preserved: first=%#v updated=%#v", first.Outcome.Criteria, updated.Outcome.Criteria)
	}

	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", `{"statement":"stale","criteria":[],"expectedRevision":1,"idempotencyKey":"stale-1"}`)
	if status != http.StatusConflict {
		t.Fatalf("stale PUT = %d, want 409; body=%s", status, body)
	}
	var conflict errorBody
	mustJSON(t, body, &conflict)
	if conflict.Code != "PROJECT_CONTROL_REVISION_CONFLICT" || conflict.Details["currentRevision"] != float64(2) {
		t.Fatalf("conflict = %#v", conflict)
	}

	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", `{"statement":"different","criteria":[],"expectedRevision":0,"idempotencyKey":"create-1"}`)
	assertErrorCode(t, body, status, http.StatusConflict, "PROJECT_CONTROL_IDEMPOTENCY_CONFLICT")
}

func TestProjectControlAPI_ValidationAndWireCompatibility(t *testing.T) {
	srv := newProjectControlServer(t)
	tests := []struct {
		name string
		body string
		code string
	}{
		{"missing statement", `{"criteria":[],"expectedRevision":0,"idempotencyKey":"x"}`, "INVALID_PROJECT_OUTCOME"},
		{"missing expected revision", `{"statement":"ship","criteria":[],"idempotencyKey":"x"}`, "INVALID_PROJECT_OUTCOME"},
		{"null expected revision", `{"statement":"ship","criteria":[],"expectedRevision":null,"idempotencyKey":"x"}`, "INVALID_PROJECT_OUTCOME"},
		{"null criteria", `{"statement":"ship","criteria":null,"expectedRevision":0,"idempotencyKey":"x"}`, "INVALID_PROJECT_OUTCOME"},
		{"missing verification method", `{"statement":"ship","criteria":[{"statement":"test","displayOrder":0}],"expectedRevision":0,"idempotencyKey":"x"}`, "INVALID_PROJECT_OUTCOME"},
		{"duplicate order", `{"statement":"ship","criteria":[{"statement":"a","verificationMethod":"x","displayOrder":0},{"statement":"b","verificationMethod":"y","displayOrder":0}],"expectedRevision":0,"idempotencyKey":"x"}`, "DUPLICATE_ACCEPTANCE_CRITERION_DISPLAY_ORDER"},
		{"unknown field", `{"statement":"ship","criteria":[],"expectedRevision":0,"idempotencyKey":"x","health":"green"}`, "INVALID_JSON"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, status, headers := doRequest(t, srv, http.MethodPut, "/api/v1/projects/demo/outcome", tt.body)
			assertJSON(t, headers)
			assertErrorCode(t, body, status, http.StatusBadRequest, tt.code)
		})
	}
}

func TestProjectControlRoutes_DefaultToStubsWithoutService(t *testing.T) {
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	for _, test := range []struct{ method, path string }{{http.MethodGet, "/api/v1/projects/demo/control"}, {http.MethodPut, "/api/v1/projects/demo/outcome"}} {
		body, status, _ := doRequest(t, srv, test.method, test.path, `{}`)
		assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
	}
}
