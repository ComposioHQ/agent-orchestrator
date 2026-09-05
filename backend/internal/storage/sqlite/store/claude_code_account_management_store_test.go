package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestClaudeCodeActiveAccountUsesRevisionCAS(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	first, err := st.SetClaudeCodeActiveAccount(ctx, "account-a", 0, now)
	if err != nil || first.AccountID != "account-a" || first.Revision != 1 {
		t.Fatalf("create active account: got=%+v err=%v", first, err)
	}
	second, err := st.SetClaudeCodeActiveAccount(ctx, "account-b", 1, now.Add(time.Second))
	if err != nil || second.AccountID != "account-b" || second.Revision != 2 {
		t.Fatalf("advance active account: got=%+v err=%v", second, err)
	}
	if _, err := st.SetClaudeCodeActiveAccount(ctx, "account-c", 1, now.Add(2*time.Second)); !errors.Is(err, ports.ErrClaudeCodeAccountRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
}

func TestClaudeCodeAccountSwitchIsIdempotentAndCASUpdated(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	sw := domain.ClaudeCodeAccountSwitch{
		ID: "switch-a", SourceAccountID: "account-a", TargetAccountID: "account-b",
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, Phase: domain.ClaudeCodeAccountSwitchRequested,
		IdempotencyKey: "request-a", RequestFingerprint: "v1:account-b:1", ExpectedAccountRevision: 1,
		CreatedAt: now, UpdatedAt: now,
	}
	created, inserted, err := st.CreateClaudeCodeAccountSwitch(ctx, sw)
	if err != nil || !inserted || created.ID != sw.ID {
		t.Fatalf("create switch: got=%+v inserted=%v err=%v", created, inserted, err)
	}
	replayed, inserted, err := st.CreateClaudeCodeAccountSwitch(ctx, sw)
	if err != nil || inserted || replayed.ID != sw.ID {
		t.Fatalf("replay switch: got=%+v inserted=%v err=%v", replayed, inserted, err)
	}

	sw.Phase = domain.ClaudeCodeAccountSwitchVerifyingTarget
	sw.UpdatedAt = now.Add(time.Second)
	if ok, err := st.UpdateClaudeCodeAccountSwitch(ctx, sw, domain.ClaudeCodeAccountSwitchRequested); err != nil || !ok {
		t.Fatalf("switch transition: ok=%v err=%v", ok, err)
	}
	if ok, err := st.UpdateClaudeCodeAccountSwitch(ctx, sw, domain.ClaudeCodeAccountSwitchRequested); err != nil || ok {
		t.Fatalf("stale switch transition: ok=%v err=%v", ok, err)
	}
}

func TestClaudeCodeAccountSwitchRejectsMismatchedIdempotentReplay(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	original := domain.ClaudeCodeAccountSwitch{
		ID: "switch-original", SourceAccountID: "account-a", TargetAccountID: "account-b",
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, Phase: domain.ClaudeCodeAccountSwitchRequested,
		IdempotencyKey: "request-shared", RequestFingerprint: "v1:account-b:1", ExpectedAccountRevision: 1,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, _, err := st.CreateClaudeCodeAccountSwitch(ctx, original); err != nil {
		t.Fatalf("create original switch: %v", err)
	}
	conflict := original
	conflict.ID = "switch-conflict"
	conflict.TargetAccountID = "account-c"
	conflict.RequestFingerprint = "v1:account-c:1"
	if _, _, err := st.CreateClaudeCodeAccountSwitch(ctx, conflict); !errors.Is(err, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict) {
		t.Fatalf("mismatched replay error = %v", err)
	}
}

func TestClaudeCodeAccountSwitchAllowsOnlyOneNonterminalOperation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	first := domain.ClaudeCodeAccountSwitch{
		ID: "switch-first", SourceAccountID: "account-a", TargetAccountID: "account-b",
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, Phase: domain.ClaudeCodeAccountSwitchRequested,
		IdempotencyKey: "request-first", RequestFingerprint: "v1:account-b:1", ExpectedAccountRevision: 1,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, _, err := st.CreateClaudeCodeAccountSwitch(ctx, first); err != nil {
		t.Fatalf("create first switch: %v", err)
	}
	second := first
	second.ID = "switch-second"
	second.IdempotencyKey = "request-second"
	second.RequestFingerprint = "v1:account-c:1"
	second.TargetAccountID = "account-c"
	if existing, _, err := st.CreateClaudeCodeAccountSwitch(ctx, second); !errors.Is(err, ports.ErrClaudeCodeAccountSwitchInProgress) || existing.ID != first.ID {
		t.Fatalf("second active switch: existing=%+v err=%v", existing, err)
	}

	first.Phase = domain.ClaudeCodeAccountSwitchFailed
	first.UpdatedAt = now.Add(time.Second)
	first.CompletedAt = &first.UpdatedAt
	if ok, err := st.UpdateClaudeCodeAccountSwitch(ctx, first, domain.ClaudeCodeAccountSwitchRequested); err != nil || !ok {
		t.Fatalf("finish first switch: ok=%v err=%v", ok, err)
	}
	if _, inserted, err := st.CreateClaudeCodeAccountSwitch(ctx, second); err != nil || !inserted {
		t.Fatalf("create second switch after terminal state: inserted=%v err=%v", inserted, err)
	}
}
