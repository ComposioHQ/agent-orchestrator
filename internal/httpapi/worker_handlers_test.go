package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/githubapp"
	"github.com/Untrivial-ai/ao-cloud/internal/secrets"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

type workerHandlerStore struct {
	Store
	credential domain.WorkerCredential
}

func (s workerHandlerStore) WorkerAgentCredential(
	context.Context,
	string,
	string,
	string,
	int64,
) (domain.WorkerCredential, error) {
	return s.credential, nil
}

type checkoutEndpointStore struct {
	Store
	current bool
}

func (s checkoutEndpointStore) WorkerConnectionCurrent(
	context.Context, string, string, string, int64,
) (bool, error) {
	return s.current, nil
}

type recordingCheckoutBroker struct {
	calls int
	grant githubapp.CheckoutGrant
}

func TestNewDoesNotInstallTypedNilCheckoutBroker(t *testing.T) {
	server := New(Options{})
	if server.checkoutBroker != nil {
		t.Fatal("nil GitHub service became a non-nil checkout broker interface")
	}
}

func (b *recordingCheckoutBroker) IssueCheckoutGrant(
	context.Context, string, string,
) (githubapp.CheckoutGrant, error) {
	b.calls++
	return b.grant, nil
}

func TestWorkerEventAllowlistIsExact(t *testing.T) {
	for _, eventType := range []string{"worker.ready", "chat.assistant_delta"} {
		if !allowedWorkerEventType(eventType) {
			t.Fatalf("%q should be allowed", eventType)
		}
	}
	for _, eventType := range []string{
		"worker.connected",
		"chat.turn_completed",
		"terminal.output",
		"billing.credit",
		"chat.assistant_delta.extra",
	} {
		if allowedWorkerEventType(eventType) {
			t.Fatalf("%q should be denied", eventType)
		}
	}
}

func TestWorkerTokenResponsesAreNeverCacheable(t *testing.T) {
	server := &Server{logger: slog.Default()}
	for name, handler := range map[string]http.HandlerFunc{
		"bootstrap": server.workerBootstrap,
		"heartbeat": server.workerHeartbeat,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
			request = request.WithContext(context.WithValue(
				request.Context(), workerContextKey{}, worker.Claims{},
			))
			response := httptest.NewRecorder()
			handler(response, request)
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestWorkerCredentialIsDecryptedWithNoStore(t *testing.T) {
	cipher, err := secrets.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, nonce, err := cipher.Encrypt(
		[]byte("credential-secret"),
		providerSecretAssociatedData("org-1", "claude-code"),
	)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		store: workerHandlerStore{credential: domain.WorkerCredential{
			Provider:        "claude-code",
			CredentialType:  "api_key",
			EncryptedSecret: encrypted,
			Nonce:           nonce,
		}},
		secretCipher: cipher,
	}
	request := httptest.NewRequest(http.MethodGet, "/worker/credential", nil)
	request = request.WithContext(context.WithValue(
		request.Context(),
		workerContextKey{},
		worker.Claims{
			OrgID: "org-1", SessionID: "session-1", WorkerID: "worker-1",
			Epoch: 1, Scopes: []string{"worker:credential:read"},
		},
	))
	response := httptest.NewRecorder()
	server.workerCredential(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	var body worker.CredentialResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Secret != "credential-secret" || body.Provider != "claude-code" {
		t.Fatalf("credential response = %#v", body)
	}
}

func TestWorkerCheckoutGrantEnforcesEpochScopeAndNoStore(t *testing.T) {
	const checkoutToken = "github-token-that-must-not-be-logged"
	tokens := worker.NewTokenManager([]byte("0123456789abcdef0123456789abcdef"))
	credential, err := tokens.Issue(worker.Claims{
		OrgID: "org", SessionID: "session", WorkerID: "session:7", Epoch: 7,
		Scopes: []string{"worker:git"},
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	server := New(Options{
		Store: checkoutEndpointStore{current: true}, WorkerTokens: tokens,
		Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
	})
	broker := &recordingCheckoutBroker{grant: githubapp.CheckoutGrant{
		CloneURL: "https://github.com/acme/api.git", Token: checkoutToken,
		ExpiresAt: time.Now().Add(time.Hour),
	}}
	server.checkoutBroker = broker
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/worker/checkout-grant", nil)
	request.Header.Set("Authorization", "Worker "+credential)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	var grant worker.CheckoutGrantResponse
	_ = json.Unmarshal(response.Body.Bytes(), &grant)
	if response.Code != http.StatusOK ||
		response.Header().Get("Cache-Control") != "no-store" ||
		grant.Token != checkoutToken || broker.calls != 1 ||
		strings.Contains(logs.String(), checkoutToken) {
		t.Fatalf("status=%d headers=%v grant=%#v calls=%d logs=%s",
			response.Code, response.Header(), grant, broker.calls, logs.String())
	}

	stale := New(Options{Store: checkoutEndpointStore{current: false}, WorkerTokens: tokens})
	staleBroker := &recordingCheckoutBroker{grant: broker.grant}
	stale.checkoutBroker = staleBroker
	staleRequest := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/worker/checkout-grant", nil)
	staleRequest.Header.Set("Authorization", "Worker "+credential)
	staleResponse := httptest.NewRecorder()
	stale.Handler().ServeHTTP(staleResponse, staleRequest)
	if staleResponse.Code != http.StatusUnauthorized || staleBroker.calls != 0 {
		t.Fatalf("stale status=%d calls=%d", staleResponse.Code, staleBroker.calls)
	}
}

func TestWorkerCheckoutGrantRequiresGitScope(t *testing.T) {
	server := &Server{logger: slog.Default()}
	broker := &recordingCheckoutBroker{}
	server.checkoutBroker = broker
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request = request.WithContext(context.WithValue(request.Context(), workerContextKey{}, worker.Claims{
		Scopes: []string{"worker:event"},
	}))
	response := httptest.NewRecorder()
	server.workerCheckoutGrant(response, request)
	if response.Code != http.StatusForbidden || broker.calls != 0 ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d calls=%d cache=%q",
			response.Code, broker.calls, response.Header().Get("Cache-Control"))
	}
}

func TestWorkerOrchestrationRequiresOrchestrateScope(t *testing.T) {
	server := &Server{logger: slog.Default()}
	request := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/worker/children", nil)
	request = request.WithContext(context.WithValue(request.Context(), workerContextKey{}, worker.Claims{
		Scopes: []string{"worker:git"},
	}))
	response := httptest.NewRecorder()
	server.listWorkerChildren(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want forbidden", response.Code)
	}
}
