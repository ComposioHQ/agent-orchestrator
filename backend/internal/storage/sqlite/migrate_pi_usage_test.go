package sqlite

import (
	"testing"
	"time"
)

// TestMigration0109DownPreservesKimiUsage catches rolling back Pi by deleting
// sibling-provider usage that belongs to the still-applied Kimi migration.
func TestMigration0109DownPreservesKimiUsage(t *testing.T) {
	db := openTestDB(t)
	upTo(t, db, 109)
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	if _, err := db.Exec(`INSERT INTO projects (id, path, display_name, registered_at) VALUES ('usage-migration', '/tmp/usage-migration', 'usage', ?)`, now); err != nil {
		t.Fatal(err)
	}
	for _, harness := range []string{"kimi", "pi"} {
		if _, err := db.Exec(`INSERT INTO sessions (id, project_id, num, kind, harness, activity_state, activity_last_at, is_terminated, created_at, updated_at) VALUES (?, 'usage-migration', ?, 'worker', ?, 'active', ?, 0, ?, ?)`, "session-"+harness, map[string]int{"kimi": 1, "pi": 2}[harness], harness, now, now, now); err != nil {
			t.Fatalf("seed %s session: %v", harness, err)
		}
		result, err := db.Exec(`INSERT INTO usage_bindings (session_id, harness, native_root_id, state, updated_at) VALUES (?, ?, ?, 'active', ?)`, "session-"+harness, harness, "native-"+harness, now)
		if err != nil {
			t.Fatalf("seed %s binding: %v", harness, err)
		}
		bindingID, _ := result.LastInsertId()
		kind := map[string]string{"kimi": "kimi_wire", "pi": "pi_session"}[harness]
		result, err = db.Exec(`INSERT INTO usage_sources (binding_id, kind, native_session_id, artifact_path, state, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`, bindingID, kind, "native-"+harness, "/tmp/"+harness+".jsonl", now)
		if err != nil {
			t.Fatalf("seed %s source: %v", harness, err)
		}
		sourceID, _ := result.LastInsertId()
		result, err = db.Exec(`INSERT INTO model_usage_events (binding_id, usage_source_id, provider_id, model_id, input_tokens, input_provenance, cached_input_tokens, cached_input_provenance, uncached_input_tokens, uncached_input_provenance, output_tokens, output_provenance, source_event_key, created_at) VALUES (?, ?, 'anthropic', 'model', 3, 'reported', 1, 'reported', 2, 'reported', 1, 'reported', ?, ?)`, bindingID, sourceID, "event-"+harness, now)
		if err != nil {
			t.Fatalf("seed %s event: %v", harness, err)
		}
		eventID, _ := result.LastInsertId()
		if _, err := db.Exec(`INSERT INTO anthropic_usage_event_details (event_id, anthropic_direct_uncached_input_tokens) VALUES (?, 2)`, eventID); err != nil {
			t.Fatalf("seed %s details: %v", harness, err)
		}
	}

	downTo(t, db, 107)
	var kimiEvents, piEvents int
	if err := db.QueryRow(`SELECT COUNT(*) FROM model_usage_events event JOIN usage_bindings binding ON binding.id = event.binding_id WHERE binding.harness = 'kimi'`).Scan(&kimiEvents); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM model_usage_events event JOIN usage_bindings binding ON binding.id = event.binding_id WHERE binding.harness = 'pi'`).Scan(&piEvents); err != nil {
		t.Fatal(err)
	}
	if kimiEvents != 1 || piEvents != 0 {
		t.Fatalf("events after Pi rollback = kimi:%d pi:%d, want 1/0", kimiEvents, piEvents)
	}
}
