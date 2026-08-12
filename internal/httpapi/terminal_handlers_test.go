package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
)

type terminalKindStore struct {
	Store
	kind string
}

func (s *terminalKindStore) OpenTerminal(
	_ context.Context,
	_ string,
	kind string,
	_ time.Duration,
) (domain.TerminalSession, error) {
	s.kind = kind
	return domain.TerminalSession{}, postgres.ErrInvalidTicket
}

func TestTerminalConnectionDefaultsToWorkspaceKind(t *testing.T) {
	store := &terminalKindStore{}
	server := &Server{store: store}
	request := httptest.NewRequest(http.MethodGet, "/terminal?ticket=test", nil)
	response := httptest.NewRecorder()

	server.connectTerminal(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if store.kind != "workspace" {
		t.Fatalf("terminal kind = %q, want workspace", store.kind)
	}
}
