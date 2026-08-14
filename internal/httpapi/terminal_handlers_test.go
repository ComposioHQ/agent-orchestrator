package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/coder/websocket"
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

type terminalOutputStore struct {
	Store
}

func (s *terminalOutputStore) ListTerminalOutput(
	_ context.Context,
	_ domain.TerminalSession,
	_ int64,
	_ int,
) ([]domain.TerminalOutput, string, error) {
	return []domain.TerminalOutput{{
		Sequence: 1,
		Data:     []byte{0xe2, 0x82},
	}}, "closed", nil
}

func TestTerminalOutputUsesBinaryFramesForPartialUTF8(t *testing.T) {
	server := &Server{store: &terminalOutputStore{}}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer connection.CloseNow()
		_ = server.writeTerminalOutput(
			r.Context(),
			connection,
			domain.TerminalSession{},
			0,
			true,
			&sync.Mutex{},
		)
	}))
	t.Cleanup(httpServer.Close)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(
		ctx,
		"ws"+strings.TrimPrefix(httpServer.URL, "http"),
		nil,
	)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer connection.CloseNow()

	messageType, data, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read terminal output: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v, want text", messageType)
	}
	var message terminalServerMessage
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil {
		t.Fatal(err)
	}
	if message.Type != "output" || message.Sequence != 1 || string(decoded) != string([]byte{0xe2, 0x82}) {
		t.Fatalf("message = %#v data = %v, want sequence 1 with partial UTF-8 bytes", message, decoded)
	}
}

func TestTerminalStreamFailureUsesRetryableCloseStatus(t *testing.T) {
	status, reason := terminalStreamClose(errors.New("database unavailable"), "workspace")
	if status != websocket.StatusInternalError || reason != "terminal stream interrupted" {
		t.Fatalf("close = %d %q, want retryable internal error", status, reason)
	}

	status, reason = terminalStreamClose(nil, "workspace")
	if status != websocket.StatusNormalClosure || reason != "terminal closed" {
		t.Fatalf("close = %d %q, want normal terminal closure", status, reason)
	}

	status, reason = terminalStreamClose(errTerminalProcessUnavailable, "agent")
	if status != websocket.StatusPolicyViolation || reason != "terminal process unavailable" {
		t.Fatalf("close = %d %q, want non-retryable terminal process failure", status, reason)
	}

	status, reason = terminalStreamClose(errTerminalProcessUnavailable, "workspace")
	if status != websocket.StatusTryAgainLater || reason != "workspace terminal is restarting" {
		t.Fatalf("close = %d %q, want retryable workspace terminal failure", status, reason)
	}
}

func TestTerminalResizeWaitsForOpeningShell(t *testing.T) {
	calls := 0
	err := retryTerminalRequest(context.Background(), func() error {
		calls++
		if calls == 1 {
			return postgres.ErrWorkerUnavailable
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("operation calls = %d, want 2", calls)
	}
}

func TestTerminalInputWaitsForQueueCapacity(t *testing.T) {
	calls := 0
	err := retryTerminalRequest(context.Background(), func() error {
		calls++
		if calls < 3 {
			return postgres.ErrConflict
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("operation calls = %d, want 3", calls)
	}
}
