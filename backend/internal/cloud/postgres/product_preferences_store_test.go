package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestProductPreferenceStoresRequireTenantBeforeDatabaseAccess(t *testing.T) {
	store := &Store{}
	ctx := context.Background()

	if _, err := store.GetAppSettings(ctx); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("GetAppSettings error = %v, want ErrNoTenant", err)
	}
	if err := store.SetDefaultSessionMode(ctx, domain.SessionModeChat, time.Now()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("SetDefaultSessionMode error = %v, want ErrNoTenant", err)
	}
	if _, _, _, err := store.GetAgentInventoryCache(ctx); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("GetAgentInventoryCache error = %v, want ErrNoTenant", err)
	}
	if err := store.UpsertAgentInventoryCache(ctx, `{}`, time.Now()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("UpsertAgentInventoryCache error = %v, want ErrNoTenant", err)
	}
}

func TestProductPreferenceStoresValidateBeforeDatabaseAccess(t *testing.T) {
	store := &Store{}
	ctx := tenant.WithIdentity(context.Background(), tenant.Identity{
		OrgID: "00000000-0000-0000-0000-000000000001", UserID: "00000000-0000-0000-0000-000000000002",
	})
	if err := store.SetDefaultSessionMode(ctx, domain.SessionMode("unknown"), time.Now()); err == nil {
		t.Fatal("SetDefaultSessionMode accepted invalid mode")
	}
	if err := store.UpsertAgentInventoryCache(ctx, `{`, time.Now()); err == nil {
		t.Fatal("UpsertAgentInventoryCache accepted invalid JSON")
	}
}
