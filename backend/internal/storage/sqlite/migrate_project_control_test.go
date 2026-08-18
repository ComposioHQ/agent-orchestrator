package sqlite

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/projectcontrol"
)

func TestProjectControlMigrationHasNoBackfillAndSurvivesRestart(t *testing.T) {
	dataDir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	upTo(t, db, 95)
	if _, err := db.Exec(`
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, config, kind)
VALUES ('ao', '/tmp/ao', '', 'AO', ?, NULL, 'single_repo')`, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	service := projectcontrol.NewWithDeps(projectcontrol.Deps{
		Store: store, NewID: func() string { return "stable" },
		Clock: func() time.Time { return time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC) },
	})
	unconfigured, err := service.Get(t.Context(), "ao")
	if err != nil || unconfigured.Configured || unconfigured.Revision != 0 {
		t.Fatalf("post-migration state = %#v, %v", unconfigured, err)
	}
	committed, err := service.SetOutcome(t.Context(), "ao", domain.SetOutcomeInput{
		ExpectedRevision: 0, IdempotencyKey: "restart", Statement: "Durable",
		Criteria: []domain.AcceptanceCriterionInput{{Statement: "Restarts", VerificationMethod: "Reopen", DisplayOrder: 0}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restarted := projectcontrol.NewWithDeps(projectcontrol.Deps{
		Store: reopened, NewID: func() string { return "different" },
		Clock: func() time.Time { return time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC) },
	})
	loaded, err := restarted.Get(t.Context(), "ao")
	if err != nil || !reflect.DeepEqual(loaded, committed) {
		t.Fatalf("restarted state = %#v, %v; want %#v", loaded, err, committed)
	}
	retried, err := restarted.SetOutcome(t.Context(), "ao", domain.SetOutcomeInput{
		ExpectedRevision: 0, IdempotencyKey: "restart", Statement: "Durable",
		Criteria: []domain.AcceptanceCriterionInput{{Statement: "Restarts", VerificationMethod: "Reopen", DisplayOrder: 0}},
	})
	if err != nil || !reflect.DeepEqual(retried, committed) {
		t.Fatalf("restart retry = %#v, %v; want %#v", retried, err, committed)
	}
	changes, err := reopened.EventsAfter(t.Context(), 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	var controlChanges []cdc.Event
	for _, event := range changes {
		if event.Type == cdc.EventProjectControlUpdated {
			controlChanges = append(controlChanges, event)
		}
	}
	if len(controlChanges) != 1 {
		t.Fatalf("project control CDC events = %d, want one per distinct command", len(controlChanges))
	}
	if controlChanges[0].ProjectID != "ao" || controlChanges[0].SessionID != "" {
		t.Fatalf("project control CDC scope = %#v", controlChanges[0])
	}
	var payload struct {
		Revision  int64  `json:"revision"`
		OutcomeID string `json:"outcomeId"`
	}
	if err := json.Unmarshal(controlChanges[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Revision != committed.Revision || payload.OutcomeID != string(committed.Outcome.ID) {
		t.Fatalf("project control CDC payload = %#v, want revision %d outcome %s", payload, committed.Revision, committed.Outcome.ID)
	}
	verifyDB, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer verifyDB.Close()
	var events int
	if err := verifyDB.QueryRow(`SELECT COUNT(*) FROM project_control_events`).Scan(&events); err != nil || events != 1 {
		t.Fatalf("events after restart retry = %d, %v", events, err)
	}
}
