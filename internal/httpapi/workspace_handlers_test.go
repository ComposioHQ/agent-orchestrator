package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/go-chi/chi/v5"
)

type pendingWorkspaceStore struct {
	Store
	mu        sync.Mutex
	cancelled int
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
