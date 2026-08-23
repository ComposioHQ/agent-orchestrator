// Package storagetest contains adapter-neutral persistence conformance suites.
package storagetest

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// PreferenceStore is the product preference surface shared by local and
// hosted adapters.
type PreferenceStore interface {
	ports.SettingsStore
	ports.AgentInventoryCache
}

// RunPreferenceConformance verifies settings and advisory inventory behavior
// without depending on either SQL dialect.
func RunPreferenceConformance(t testing.TB, ctx context.Context, store PreferenceStore) {
	t.Helper()
	now := time.Date(2026, 8, 23, 12, 30, 0, 123000000, time.UTC)

	if err := store.SetDefaultSessionMode(ctx, domain.SessionModeTUI, now); err != nil {
		t.Fatalf("set default session mode: %v", err)
	}
	settings, err := store.GetAppSettings(ctx)
	if err != nil {
		t.Fatalf("get settings: %v", err)
	}
	if settings.DefaultSessionMode != domain.SessionModeTUI || !settings.UpdatedAt.Equal(now) {
		t.Fatalf("settings = %+v", settings)
	}

	if _, _, ok, err := store.GetAgentInventoryCache(ctx); err != nil || ok {
		t.Fatalf("empty inventory = ok:%v err:%v", ok, err)
	}
	wantJSON := `{"installed":["codex"],"authenticated":["codex"]}`
	if err := store.UpsertAgentInventoryCache(ctx, wantJSON, now); err != nil {
		t.Fatalf("upsert inventory: %v", err)
	}
	gotJSON, observedAt, ok, err := store.GetAgentInventoryCache(ctx)
	if err != nil || !ok {
		t.Fatalf("get inventory = ok:%v err:%v", ok, err)
	}
	if !observedAt.Equal(now) || !sameJSON(gotJSON, wantJSON) {
		t.Fatalf("inventory = json:%s observed:%s", gotJSON, observedAt)
	}
}

func sameJSON(left, right string) bool {
	var a, b any
	return json.Unmarshal([]byte(left), &a) == nil &&
		json.Unmarshal([]byte(right), &b) == nil &&
		reflect.DeepEqual(a, b)
}
