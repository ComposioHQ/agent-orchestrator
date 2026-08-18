package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"

	_ "modernc.org/sqlite"
)

func TestProjectControlReadUsesOneSnapshotAcrossConcurrentSet(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "snapshot.db") +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	writeDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	readDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(writeDB, readDB)
	t.Cleanup(func() { _ = store.Close() })

	if _, err := writeDB.Exec(`
CREATE TABLE projects (id TEXT PRIMARY KEY, archived_at TIMESTAMP);
CREATE TABLE project_control_heads (
    project_id TEXT PRIMARY KEY, root_outcome_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL, owner_role TEXT NOT NULL
);
CREATE TABLE project_control_outcomes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, statement TEXT NOT NULL
);
CREATE TABLE project_control_acceptance_criteria (
    id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL, statement TEXT NOT NULL,
    verification_method TEXT NOT NULL, display_order INTEGER NOT NULL,
    UNIQUE (outcome_id, display_order)
);
CREATE TABLE project_control_set_results (
    project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY (project_id, idempotency_key),
    UNIQUE (project_id, revision)
);
CREATE TABLE project_control_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    outcome_id TEXT NOT NULL, revision INTEGER NOT NULL, event_type TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TIMESTAMP NOT NULL,
    UNIQUE (project_id, revision)
);
INSERT INTO projects (id) VALUES ('ao');`); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	first := domain.SetOutcomeMutation{
		ExpectedRevision: 0, IdempotencyKey: "first", RequestFingerprint: "v1:first",
		OutcomeIDCandidate: "outcome-1", Statement: "revision one", OccurredAt: time.Now().UTC(),
		Criteria: []domain.AcceptanceCriterionMutation{{
			ID: "criterion-1", Create: true, Statement: "criterion one",
			VerificationMethod: "verify one", DisplayOrder: 0,
		}},
	}
	if _, err := store.SetOutcome(ctx, "ao", first); err != nil {
		t.Fatal(err)
	}

	readTx, err := readDB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = readTx.Rollback() }()

	var writeErr error
	snapshot, exists, err := getProjectControlSnapshot(ctx, gen.New(readTx), "ao", func() {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, writeErr = store.SetOutcome(ctx, "ao", domain.SetOutcomeMutation{
				ExpectedRevision: 1, IdempotencyKey: "second", RequestFingerprint: "v1:second",
				OutcomeIDCandidate: "unused", Statement: "revision two", OccurredAt: time.Now().UTC(),
				Criteria: []domain.AcceptanceCriterionMutation{{
					ID: "criterion-1", Statement: "criterion two",
					VerificationMethod: "verify two", DisplayOrder: 0,
				}},
			})
		}()
		<-done
	})
	if err != nil {
		t.Fatal(err)
	}
	if writeErr != nil {
		t.Fatal(writeErr)
	}
	if !exists || snapshot.Revision != 1 || snapshot.Outcome == nil ||
		snapshot.Outcome.Statement != "revision one" ||
		len(snapshot.Outcome.Criteria) != 1 || snapshot.Outcome.Criteria[0].Statement != "criterion one" {
		t.Fatalf("snapshot mixed revisions: %#v", snapshot)
	}
	if err := readTx.Commit(); err != nil {
		t.Fatal(err)
	}

	current, exists, err := store.Get(ctx, "ao")
	if err != nil || !exists || current.Revision != 2 || current.Outcome == nil ||
		current.Outcome.Statement != "revision two" || current.Outcome.Criteria[0].Statement != "criterion two" {
		t.Fatalf("current state = %#v, exists=%v err=%v", current, exists, err)
	}
}
