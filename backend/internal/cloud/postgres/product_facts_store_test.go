package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestProductFactStoresRequireTenantBeforeDatabaseAccess(t *testing.T) {
	store := &Store{}
	ctx := context.Background()
	now := time.Now().UTC()
	pr := domain.PullRequest{URL: "https://github.com/acme/repo/pull/1", SessionID: "acme-1", Number: 1, UpdatedAt: now}
	if err := store.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("WriteSCMObservation error = %v", err)
	}
	if _, _, err := store.GetPR(ctx, pr.URL); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("GetPR error = %v", err)
	}
	if _, err := store.ListPRFactsForSession(ctx, pr.SessionID); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("ListPRFactsForSession error = %v", err)
	}
	rec := domain.NotificationRecord{ID: "ntf-1", SessionID: pr.SessionID, ProjectID: "acme", Type: domain.NotificationNeedsInput, Title: "Input", Status: domain.NotificationUnread, CreatedAt: now}
	if _, _, err := store.CreateNotification(ctx, rec); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("CreateNotification error = %v", err)
	}
	if _, err := store.ListNotifications(ctx, domain.NotificationListAll, time.Time{}, "", 10); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("ListNotifications error = %v", err)
	}
}
