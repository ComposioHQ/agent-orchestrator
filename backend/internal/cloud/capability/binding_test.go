package capability

import (
	"context"
	"errors"
	"testing"
	"time"
)

func bindingAuthority(t *testing.T) (*Authority, time.Time) {
	t.Helper()
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, err := New(NewMemoryStore(), time.Hour, WithClock(func() time.Time { return now }))
	if err != nil {
		t.Fatal(err)
	}
	return authority, now
}

func grantWith(t *testing.T, authority *Authority, role, session string, operations ...Operation) Grant {
	t.Helper()
	grant, err := authority.Issue(context.Background(), Scope{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		SessionID:   session,
		Role:        role,
		Operations:  operations,
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return grant
}

func TestEveryOperationDeclaresABinding(t *testing.T) {
	// An operation with no entry in the table is unissuable. This test exists
	// so adding one and forgetting the table is caught here rather than by an
	// operation that quietly authorizes the widest possible target.
	for _, op := range []Operation{
		OpSandboxHeartbeat, OpSandboxReportState, OpCapabilityRotate,
		OpSessionSend, OpSessionRead, OpSessionSpawn,
		OpSessionPreview, OpSessionBrowser, OpSessionActivity,
	} {
		binding, ok := op.Binding()
		if !ok {
			t.Fatalf("%s has no binding", op)
		}
		switch binding {
		case BindGrant, BindWorkspace, BindSelf:
		default:
			t.Fatalf("%s has unknown binding %q", op, binding)
		}
	}
	if _, ok := Operation("session.root").Binding(); ok {
		t.Fatal("an unregistered operation reported a binding")
	}
}

func TestSendReadAndSpawnAreWorkspaceBound(t *testing.T) {
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleCoordinator, "coord-1", OpSessionSend, OpSessionRead, OpSessionSpawn)

	for _, op := range []Operation{OpSessionSend, OpSessionRead, OpSessionSpawn} {
		if binding, _ := op.Binding(); binding != BindWorkspace {
			t.Fatalf("%s binding = %s, want workspace", op, binding)
		}
		// Any session inside the granted workspace, including one that is not
		// the grant's own, is reachable. That is what orchestration needs.
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-1", SessionID: "sess-worker"}); err != nil {
			t.Fatalf("%s on a sibling session: %v", op, err)
		}
		// Spawn legitimately has no session yet.
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-1"}); err != nil {
			t.Fatalf("%s with no session named: %v", op, err)
		}
		// Another workspace is out of reach even inside the same org.
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-2", SessionID: "sess-worker"}); !errors.Is(err, ErrNotPermitted) {
			t.Fatalf("%s reached another workspace: %v", op, err)
		}
	}
}

func TestPreviewBrowserAndActivityAreSelfBound(t *testing.T) {
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleWorker, "sess-1", OpSessionPreview, OpSessionBrowser, OpSessionActivity)

	for _, op := range []Operation{OpSessionPreview, OpSessionBrowser, OpSessionActivity} {
		if binding, _ := op.Binding(); binding != BindSelf {
			t.Fatalf("%s binding = %s, want self", op, binding)
		}
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-1", SessionID: "sess-1"}); err != nil {
			t.Fatalf("%s on its own session: %v", op, err)
		}
		// A sibling session in the SAME workspace must still be refused: this
		// is the difference between self-bound and workspace-bound, and the
		// reason a compromised worker cannot drive its neighbour's browser.
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-1", SessionID: "sess-2"}); !errors.Is(err, ErrNotPermitted) {
			t.Fatalf("%s reached a sibling session: %v", op, err)
		}
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{WorkspaceID: "ws-2", SessionID: "sess-1"}); !errors.Is(err, ErrNotPermitted) {
			t.Fatalf("%s reached another workspace: %v", op, err)
		}
	}
}

func TestATargetBoundOperationFailsClosedWithoutATarget(t *testing.T) {
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleCoordinator, "coord-1",
		OpSessionSend, OpSessionPreview, OpSandboxHeartbeat)

	// A handler that authorizes "send" without saying which session it
	// resolved has checked nothing. Verify must refuse rather than pass.
	for _, op := range []Operation{OpSessionSend, OpSessionPreview} {
		if _, err := authority.Verify(ctx, grant.Token, op); !errors.Is(err, ErrNotPermitted) {
			t.Fatalf("Verify(%s) = %v, want ErrNotPermitted", op, err)
		}
		if _, err := authority.Authorize(ctx, grant.Token, op, Target{}); !errors.Is(err, ErrNotPermitted) {
			t.Fatalf("Authorize(%s, empty target) = %v, want ErrNotPermitted", op, err)
		}
	}
	// A self-bound operation with only a workspace is still unbound.
	if _, err := authority.Authorize(ctx, grant.Token, OpSessionPreview, Target{WorkspaceID: "ws-1"}); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("self-bound with no session = %v, want ErrNotPermitted", err)
	}
}

func TestGrantBoundOperationsTakeNoTarget(t *testing.T) {
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleWorker, "sess-1", OpSandboxHeartbeat)

	if _, err := authority.Verify(ctx, grant.Token, OpSandboxHeartbeat); err != nil {
		t.Fatal(err)
	}
	// Supplying a target for an operation that acts on the grant itself means
	// the caller is confused about what it is authorizing; refuse rather than
	// silently ignore the value.
	if _, err := authority.Authorize(ctx, grant.Token, OpSandboxHeartbeat, Target{WorkspaceID: "ws-1", SessionID: "sess-1"}); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("grant-bound with a target = %v, want ErrNotPermitted", err)
	}
}

func TestASelfBoundOperationCannotBeGrantedWithoutASession(t *testing.T) {
	// Minting such a grant would produce a credential that can never
	// authorize anything — a silent denial found in production instead of at
	// issuance.
	_, err := Scope{
		OrgID: "org-1", WorkspaceID: "ws-1", Role: RoleCoordinator,
		Operations: []Operation{OpSessionBrowser},
	}.Normalize()
	if !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("err = %v, want ErrInvalidScope", err)
	}
}

func TestBindingIsEnforcedAfterRotation(t *testing.T) {
	// Rotation preserves the scope, so it must preserve the binding too: a
	// successor that authorized a wider target would make rotation an
	// escalation primitive.
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleWorker, "sess-1", OpCapabilityRotate, OpSessionBrowser)

	successor, err := authority.Rotate(ctx, grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Authorize(ctx, successor.Token, OpSessionBrowser, Target{WorkspaceID: "ws-1", SessionID: "sess-1"}); err != nil {
		t.Fatalf("successor on its own session: %v", err)
	}
	if _, err := authority.Authorize(ctx, successor.Token, OpSessionBrowser, Target{WorkspaceID: "ws-1", SessionID: "sess-2"}); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("successor reached a sibling session: %v", err)
	}
}

func TestRevocationBeatsBinding(t *testing.T) {
	// A revoked grant must fail as revoked before any binding check runs, so a
	// torn-down session's credential cannot be probed for scope information.
	authority, _ := bindingAuthority(t)
	ctx := context.Background()
	grant := grantWith(t, authority, RoleWorker, "sess-1", OpSessionActivity)
	if err := authority.Revoke(ctx, grant.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Authorize(ctx, grant.Token, OpSessionActivity, Target{WorkspaceID: "ws-1", SessionID: "sess-1"}); !errors.Is(err, ErrRevoked) {
		t.Fatalf("err = %v, want ErrRevoked", err)
	}
}
