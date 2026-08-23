package capability

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type stubVerifier struct {
	verified Verified
	err      error
	sawToken string
	sawOp    Operation
}

func (s *stubVerifier) Verify(_ context.Context, token string, op Operation) (Verified, error) {
	s.sawToken = token
	s.sawOp = op
	return s.verified, s.err
}

func serve(t *testing.T, verifier Verifier, op Operation, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	handler := Require(verifier, op)(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		verified, ok := FromContext(request.Context())
		if !ok {
			t.Fatal("verified capability missing from request context")
		}
		_ = json.NewEncoder(writer).Encode(map[string]string{"session": verified.Scope.SessionID})
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestRequireAttachesScopeAndPinsTheOperation(t *testing.T) {
	verifier := &stubVerifier{verified: Verified{
		ID:        "grant-1",
		Scope:     Scope{OrgID: "org-1", WorkspaceID: "workspace-1", SessionID: "session-1", Role: RoleWorker},
		ExpiresAt: time.Now().Add(time.Hour),
	}}
	request := httptest.NewRequest(http.MethodPost, "/sandbox/heartbeat", nil)
	request.Header.Set("Authorization", "Bearer aocap_v1.abc.def")
	// A body naming a different operation must not change what is authorized.
	request.Header.Set("X-AO-Operation", string(OpSessionSpawn))

	response := serve(t, verifier, OpSandboxHeartbeat, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if verifier.sawOp != OpSandboxHeartbeat {
		t.Fatalf("verified operation = %q, want the route's fixed operation", verifier.sawOp)
	}
	if verifier.sawToken != "aocap_v1.abc.def" {
		t.Fatalf("token = %q", verifier.sawToken)
	}
}

func TestRequireRejectsMissingAndNonBearerCredentials(t *testing.T) {
	for name, header := range map[string]string{
		"absent":      "",
		"basic":       "Basic dXNlcjpwYXNz",
		"scheme only": "Bearer",
		"empty value": "Bearer   ",
	} {
		request := httptest.NewRequest(http.MethodPost, "/sandbox/heartbeat", nil)
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response := serve(t, &stubVerifier{}, OpSandboxHeartbeat, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", name, response.Code)
		}
		if response.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: missing WWW-Authenticate challenge", name)
		}
	}
}

func TestRequireIgnoresQueryStringCredentials(t *testing.T) {
	// A capability in a URL lands in proxy and access logs, so it must not be
	// an accepted carrier even when it is otherwise valid.
	request := httptest.NewRequest(http.MethodPost, "/sandbox/heartbeat?capability=aocap_v1.abc.def", nil)
	response := serve(t, &stubVerifier{}, OpSandboxHeartbeat, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestRequireMapsCredentialFailuresToStatuses(t *testing.T) {
	for name, testCase := range map[string]struct {
		err    error
		status int
		code   string
	}{
		"invalid":    {ErrInvalidToken, http.StatusUnauthorized, "capability_invalid"},
		"expired":    {ErrExpired, http.StatusUnauthorized, "capability_expired"},
		"revoked":    {ErrRevoked, http.StatusUnauthorized, "capability_revoked"},
		"forbidden":  {ErrNotPermitted, http.StatusForbidden, "capability_forbidden"},
		"store down": {context.DeadlineExceeded, http.StatusInternalServerError, "capability_unavailable"},
	} {
		request := httptest.NewRequest(http.MethodPost, "/sandbox/heartbeat", nil)
		request.Header.Set("Authorization", "Bearer aocap_v1.abc.def")
		response := serve(t, &stubVerifier{err: testCase.err}, OpSandboxHeartbeat, request)
		if response.Code != testCase.status {
			t.Fatalf("%s: status = %d, want %d", name, response.Code, testCase.status)
		}
		var body struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if body.Error.Code != testCase.code {
			t.Fatalf("%s: code = %q, want %q", name, body.Error.Code, testCase.code)
		}
	}
}

func TestRequireRefusesATargetBoundOperation(t *testing.T) {
	// Require has no way to say what the request acts on, so wiring a
	// target-bound operation through it must fail rather than authorize an
	// unbounded action. The authority enforces this; the middleware surfaces
	// it as a 403.
	authority, err := New(NewMemoryStore(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := authority.Issue(context.Background(), Scope{
		OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", Role: RoleWorker,
		Operations: []Operation{OpSessionActivity},
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/activity", nil)
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	response := serve(t, authority, OpSessionActivity, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}

func serveTarget(t *testing.T, authorizer Authorizer, op Operation, resolve TargetResolver, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	handler := RequireTarget(authorizer, op, resolve)(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestRequireTargetAuthorizesAgainstTheResolvedTargetNotTheBody(t *testing.T) {
	authority, err := New(NewMemoryStore(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := authority.Issue(context.Background(), Scope{
		OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", Role: RoleWorker,
		Operations: []Operation{OpSessionBrowser},
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// The route resolves the target from the path. A caller that puts a
	// different session in a header or body cannot move it.
	resolve := func(request *http.Request) (Target, error) {
		session := strings.TrimPrefix(request.URL.Path, "/sessions/")
		if session == "" {
			return Target{}, errors.New("no session in path")
		}
		return Target{WorkspaceID: "ws-1", SessionID: session}, nil
	}

	own := httptest.NewRequest(http.MethodPost, "/sessions/sess-1", nil)
	own.Header.Set("Authorization", "Bearer "+grant.Token)
	own.Header.Set("X-AO-Session", "sess-2")
	if response := serveTarget(t, authority, OpSessionBrowser, resolve, own); response.Code != http.StatusOK {
		t.Fatalf("own session status = %d", response.Code)
	}

	sibling := httptest.NewRequest(http.MethodPost, "/sessions/sess-2", nil)
	sibling.Header.Set("Authorization", "Bearer "+grant.Token)
	// A client-supplied "this is really my session" hint must not help.
	sibling.Header.Set("X-AO-Session", "sess-1")
	if response := serveTarget(t, authority, OpSessionBrowser, resolve, sibling); response.Code != http.StatusForbidden {
		t.Fatalf("sibling session status = %d, want 403", response.Code)
	}
}

func TestRequireTargetReportsAnUnresolvableTargetAsABadRequest(t *testing.T) {
	// An unresolvable target is the route's problem, not a credential problem;
	// reporting 401 would send a caller chasing its token.
	authority, err := New(NewMemoryStore(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := authority.Issue(context.Background(), Scope{
		OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", Role: RoleWorker,
		Operations: []Operation{OpSessionBrowser},
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/sessions/", nil)
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	response := serveTarget(t, authority, OpSessionBrowser, func(*http.Request) (Target, error) {
		return Target{}, errors.New("session not found")
	}, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if !strings.Contains(response.Body.String(), "target_unresolved") {
		t.Fatalf("body = %s", response.Body.String())
	}
}
