package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/go-chi/chi/v5"
)

type pendingWorkspaceStore struct {
	Store
	mu        sync.Mutex
	cancelled int
}

type completedWorkspaceStore struct {
	Store
	eventType string
	eventData json.RawMessage
}

func (s *completedWorkspaceStore) CreateWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
	json.RawMessage,
	time.Duration,
) (domain.WorkerRequest, error) {
	return domain.WorkerRequest{ID: "00000000-0000-0000-0000-000000000004"}, nil
}

func (s *completedWorkspaceStore) GetWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
) (domain.WorkerRequest, error) {
	return domain.WorkerRequest{
		Status:   "succeeded",
		Response: json.RawMessage(`{"path":"README.md","content":"updated","size":7}`),
	}, nil
}

func (s *completedWorkspaceStore) AppendSessionEvent(
	_ context.Context,
	_ string,
	_ string,
	eventType string,
	payload json.RawMessage,
) (domain.ClientEvent, error) {
	s.eventType = eventType
	s.eventData = append(json.RawMessage(nil), payload...)
	return domain.ClientEvent{Type: eventType, Payload: payload}, nil
}

func (s *pendingWorkspaceStore) CreateWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
	json.RawMessage,
	time.Duration,
) (domain.WorkerRequest, error) {
	return domain.WorkerRequest{ID: "00000000-0000-0000-0000-000000000003"}, nil
}

func (s *pendingWorkspaceStore) GetWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
) (domain.WorkerRequest, error) {
	return domain.WorkerRequest{Status: "pending"}, nil
}

func (s *pendingWorkspaceStore) CancelWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelled++
	return nil
}

func (s *pendingWorkspaceStore) cancelCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancelled
}

func TestWorkspaceRequestTimesOutAndCancelsDurableCommand(t *testing.T) {
	store := &pendingWorkspaceStore{}
	server := &Server{
		store: store, workerRequestTimeout: 20 * time.Millisecond,
		logger: slog.Default(),
	}
	request := workspaceHandlerRequest(context.Background())
	response := httptest.NewRecorder()

	server.listWorkspaceFiles(response, request)

	if response.Code != http.StatusGatewayTimeout || store.cancelCount() != 1 {
		t.Fatalf("status=%d cancelled=%d body=%s",
			response.Code, store.cancelCount(), response.Body.String())
	}
}

func TestWorkspaceDisconnectCancelsDurableCommand(t *testing.T) {
	store := &pendingWorkspaceStore{}
	server := &Server{
		store: store, workerRequestTimeout: time.Second,
		logger: slog.Default(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	request := workspaceHandlerRequest(ctx)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		server.listWorkspaceFiles(response, request)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not stop after disconnect")
	}
	if store.cancelCount() != 1 {
		t.Fatalf("cancelled=%d, want 1", store.cancelCount())
	}
}

func TestWorkspaceWriteEmitsDurableProjectionInvalidation(t *testing.T) {
	store := &completedWorkspaceStore{}
	server := &Server{
		store:                store,
		workerRequestTimeout: time.Second,
		logger:               slog.Default(),
	}
	request := workspaceHandlerRequest(context.Background())
	request.Method = http.MethodPut
	request.Body = io.NopCloser(strings.NewReader(`{"path":"README.md","content":"updated"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	server.writeWorkspaceFile(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if store.eventType != "workspace.changed" {
		t.Fatalf("event type = %q, want workspace.changed", store.eventType)
	}
	var payload map[string]string
	if err := json.Unmarshal(store.eventData, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	if payload["path"] != "README.md" {
		t.Fatalf("event path = %q, want README.md", payload["path"])
	}
}

func workspaceHandlerRequest(ctx context.Context) *http.Request {
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/orgs/00000000-0000-0000-0000-000000000001/sessions/00000000-0000-0000-0000-000000000002/workspace/files",
		nil,
	).WithContext(ctx)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", "00000000-0000-0000-0000-000000000001")
	route.URLParams.Add("sessionId", "00000000-0000-0000-0000-000000000002")
	ctx = context.WithValue(request.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "user-1"})
	return request.WithContext(ctx)
}
