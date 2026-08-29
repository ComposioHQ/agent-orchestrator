package controllers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type editQueuedStub struct {
	*fakeConversationService
	session domain.SessionID
	turnID  string
	text    string
	err     error
}

func (s *editQueuedStub) EditQueuedTurn(
	_ context.Context,
	session domain.SessionID,
	turnID, text string,
) error {
	s.session, s.turnID, s.text = session, turnID, text
	return s.err
}

func postEditQueuedTurn(t *testing.T, svc *editQueuedStub, turnID, text string) int {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Sessions:      newFakeSessionService(),
		Conversations: svc,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	resp, err := http.Post(
		srv.URL+"/api/v1/sessions/p1-1/conversation/turns/"+turnID+"/queue/edit",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("POST queue/edit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

func TestEditQueuedTurnRoute(t *testing.T) {
	svc := &editQueuedStub{fakeConversationService: &fakeConversationService{}}
	if status := postEditQueuedTurn(t, svc, "turn-queued", "updated text"); status != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", status, http.StatusNoContent)
	}
	if svc.session != "p1-1" || svc.turnID != "turn-queued" || svc.text != "updated text" {
		t.Fatalf("svc saw session=%q turn=%q text=%q", svc.session, svc.turnID, svc.text)
	}
}

type cancelQueuedStub struct {
	*fakeConversationService
	session domain.SessionID
	turnID  string
	err     error
}

func (s *cancelQueuedStub) CancelQueuedTurn(
	_ context.Context,
	session domain.SessionID,
	turnID string,
) error {
	s.session, s.turnID = session, turnID
	return s.err
}

func postCancelQueuedTurn(t *testing.T, svc *cancelQueuedStub, turnID string) int {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Sessions:      newFakeSessionService(),
		Conversations: svc,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	resp, err := http.Post(
		srv.URL+"/api/v1/sessions/p1-1/conversation/turns/"+turnID+"/cancel",
		"application/json",
		nil,
	)
	if err != nil {
		t.Fatalf("POST cancel: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

func TestCancelQueuedTurnRoute(t *testing.T) {
	svc := &cancelQueuedStub{fakeConversationService: &fakeConversationService{}}
	if status := postCancelQueuedTurn(t, svc, "turn-queued"); status != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", status, http.StatusNoContent)
	}
	if svc.session != "p1-1" || svc.turnID != "turn-queued" {
		t.Fatalf("svc saw session=%q turn=%q", svc.session, svc.turnID)
	}
}
