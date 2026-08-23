package sandboxapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime/runtimetest"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime/sandboxapi"
)

type fixture struct {
	server    *sandboxapi.Server
	manager   *runtime.Manager
	authority *capability.Authority
	store     *runtimetest.MemoryStore
	provider  *runtimetest.FakeProvider
	now       time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{now: time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)}
	f.store = runtimetest.NewMemoryStore()
	f.provider = runtimetest.NewFakeProvider()
	f.provider.Now = func() time.Time { return f.now }
	authority, err := capability.New(capability.NewMemoryStore(), time.Hour,
		capability.WithClock(func() time.Time { return f.now }))
	if err != nil {
		t.Fatal(err)
	}
	f.authority = authority
	manager, err := runtime.NewManager(runtime.Options{
		Store:              f.store,
		Provider:           f.provider,
		Capabilities:       authority,
		Deployment:         "staging",
		PublicURL:          "https://cloud.example",
		Snapshots:          map[runtime.Role]string{runtime.RoleCoordinator: "c", runtime.RoleWorker: "w"},
		Quotas:             runtime.DefaultQuotas(),
		AutoStopInterval:   30 * time.Minute,
		AutoDeleteInterval: 72 * time.Hour,
		Clock:              func() time.Time { return f.now },
		Logger:             slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.manager = manager
	server, err := sandboxapi.New(sandboxapi.Options{
		Compute:      manager,
		Capabilities: authority,
		Rotator:      authority,
		Clock:        func() time.Time { return f.now },
		Logger:       slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.server = server
	return f
}

func (f *fixture) ensure(t *testing.T, ref runtime.Ref) runtime.Placement {
	t.Helper()
	placement, err := f.manager.Ensure(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	return placement
}

func (f *fixture) post(t *testing.T, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(http.MethodPost, path, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(recorder, request)
	return recorder
}

func workerRef() runtime.Ref {
	return runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", UserID: "user-1", Role: runtime.RoleWorker}
}

func TestHeartbeatRecordsTheCheckInAndReportsTheDesiredState(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	f.now = f.now.Add(10 * time.Minute)

	response := f.post(t, "/heartbeat", placement.Capability.Token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var body struct {
		State               string    `json:"state"`
		DesiredState        string    `json:"desiredState"`
		CapabilityExpiresAt time.Time `json:"capabilityExpiresAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.State != string(runtime.StateRunning) || body.DesiredState != string(runtime.StateRunning) {
		t.Fatalf("body = %#v", body)
	}
	// A sandbox must be able to see its expiry coming rather than discover it
	// as a 401 mid-turn.
	if !body.CapabilityExpiresAt.Equal(placement.Capability.ExpiresAt) {
		t.Fatalf("expiry = %s, want %s", body.CapabilityExpiresAt, placement.Capability.ExpiresAt)
	}
	record, err := f.store.Get(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if !record.LastHeartbeatAt.Equal(f.now) {
		t.Fatalf("heartbeat = %s, want %s", record.LastHeartbeatAt, f.now)
	}
}

func TestHeartbeatSurfacesAPendingStop(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	record := placement.Record
	record.DesiredState = runtime.StateStopped
	f.store.Put(record)

	response := f.post(t, "/heartbeat", placement.Capability.Token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if !bytes.Contains(response.Body.Bytes(), []byte(`"desiredState":"stopped"`)) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestEveryRouteRequiresACapability(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/heartbeat", "/state", "/capability/rotate"} {
		response := f.post(t, path, "", nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", path, response.Code)
		}
		if response.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: missing challenge", path)
		}
	}
}

func TestTenantIdentifiersInTheBodyAreIgnored(t *testing.T) {
	f := newFixture(t)
	mine := f.ensure(t, workerRef())
	victimRef := runtime.Ref{OrgID: "org-2", WorkspaceID: "ws-9", SessionID: "sess-9", UserID: "user-9", Role: runtime.RoleWorker}
	victim := f.ensure(t, victimRef)

	// A sandbox naming another tenant's session must only ever affect itself.
	response := f.post(t, "/state", mine.Capability.Token, map[string]string{
		"state":     "failed",
		"error":     "attacker",
		"orgId":     victimRef.OrgID,
		"sessionId": victimRef.SessionID,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	victimRecord, err := f.store.GetByID(context.Background(), victim.Record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if victimRecord.State != runtime.StateRunning || victimRecord.Error != "" {
		t.Fatalf("another tenant's placement was mutated: %#v", victimRecord)
	}
	mineRecord, err := f.store.GetByID(context.Background(), mine.Record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mineRecord.State != runtime.StateFailed || mineRecord.Error != "attacker" {
		t.Fatalf("the caller's own placement was not updated: %#v", mineRecord)
	}
}

func TestOperationsAreNotInterchangeable(t *testing.T) {
	f := newFixture(t)
	// A capability granted only heartbeat must not reach report-state.
	grant, err := f.authority.Issue(context.Background(), capability.Scope{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		SessionID:   "sess-1",
		Role:        capability.RoleWorker,
		Operations:  []capability.Operation{capability.OpSandboxHeartbeat},
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	f.ensure(t, workerRef())

	if response := f.post(t, "/state", grant.Token, map[string]string{"state": "running"}); response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if response := f.post(t, "/capability/rotate", grant.Token, nil); response.Code != http.StatusForbidden {
		t.Fatalf("rotate status = %d, want 403", response.Code)
	}
}

func TestRotateReturnsASuccessorAndRetiresThePresentedCapability(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	f.now = f.now.Add(30 * time.Minute)

	response := f.post(t, "/capability/rotate", placement.Capability.Token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Capability string    `json:"capability"`
		ExpiresAt  time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Capability == "" || body.Capability == placement.Capability.Token {
		t.Fatal("rotation must return a fresh credential")
	}
	// Rotation must not extend the sandbox's reach in time.
	if !body.ExpiresAt.Equal(placement.Capability.ExpiresAt) {
		t.Fatalf("expiry = %s, want the original %s", body.ExpiresAt, placement.Capability.ExpiresAt)
	}
	if response := f.post(t, "/heartbeat", placement.Capability.Token, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("retired capability status = %d, want 401", response.Code)
	}
	if response := f.post(t, "/heartbeat", body.Capability, nil); response.Code != http.StatusOK {
		t.Fatalf("successor status = %d", response.Code)
	}
}

func TestARevokedCapabilityIsRejectedImmediately(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	if err := f.manager.Delete(context.Background(), workerRef()); err != nil {
		t.Fatal(err)
	}
	response := f.post(t, "/heartbeat", placement.Capability.Token, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if !bytes.Contains(response.Body.Bytes(), []byte("capability_revoked")) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestHeartbeatForARemovedPlacementIsNotFound(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	// Drop the row without revoking the grant, modelling a partially applied
	// teardown: the listener must not resurrect the placement.
	if err := f.store.Delete(context.Background(), placement.Record.ID, placement.Record.Generation); err != nil {
		t.Fatal(err)
	}
	response := f.post(t, "/heartbeat", placement.Capability.Token, nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if f.store.Len() != 0 {
		t.Fatal("the listener recreated a placement row")
	}
}

func TestReportedStateIsValidated(t *testing.T) {
	f := newFixture(t)
	placement := f.ensure(t, workerRef())
	for _, state := range []string{"deleting", "provisioning", "banana", ""} {
		response := f.post(t, "/state", placement.Capability.Token, map[string]string{"state": state})
		if response.Code != http.StatusBadRequest {
			t.Fatalf("state %q: status = %d, want 400", state, response.Code)
		}
	}
	if response := f.post(t, "/state", placement.Capability.Token, "not-an-object"); response.Code != http.StatusBadRequest {
		t.Fatalf("non-object body: status = %d, want 400", response.Code)
	}
}

func TestNewRejectsIncompleteWiring(t *testing.T) {
	if _, err := sandboxapi.New(sandboxapi.Options{}); err == nil {
		t.Fatal("listener built with no dependencies")
	}
}
