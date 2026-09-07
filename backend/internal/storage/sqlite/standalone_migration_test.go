package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestStandaloneProjectColumnsAreNullable(t *testing.T) {
	dataDir := t.TempDir()
	store, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	for _, table := range []string{"sessions", "change_log", "notifications", "conversations"} {
		t.Run(table, func(t *testing.T) {
			rows, err := db.QueryContext(context.Background(), "PRAGMA table_info("+table+")")
			if err != nil {
				t.Fatalf("%s table info: %v", table, err)
			}
			defer rows.Close()

			found := false
			for rows.Next() {
				var cid, notNull, primaryKey int
				var name, columnType string
				var defaultValue any
				if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
					t.Fatal(err)
				}
				if name == "project_id" {
					found = true
					if notNull != 0 {
						t.Fatalf("%s.project_id remains NOT NULL", table)
					}
				}
			}
			if err := rows.Err(); err != nil {
				t.Fatalf("%s table info rows: %v", table, err)
			}
			if !found {
				t.Fatalf("%s.project_id not found", table)
			}
		})
	}
}

func TestStandaloneMigrationConvertsLegacyScratchOwnership(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 122)

	const timestamp = "2026-09-02T12:00:00Z"
	if _, err := db.Exec(`
INSERT INTO projects (id, path, display_name, registered_at, kind)
VALUES ('scratch', '/legacy/scratch', 'Scratch', ?, 'scratch');
INSERT INTO sessions (id, project_id, num, kind, harness, activity_last_at, created_at, updated_at)
VALUES
    ('scratch-1', 'scratch', 1, 'worker', 'codex', ?, ?, ?),
    ('scratch-2', 'scratch', 2, 'orchestrator', 'codex', ?, ?, ?);
INSERT INTO notifications (id, session_id, project_id, type, title, created_at)
VALUES ('notice-1', 'scratch-1', 'scratch', 'needs_input', 'Input needed', ?);
INSERT INTO conversations (id, scope, project_id, session_id, current_session_id, created_at, updated_at)
VALUES ('conversation-1', 'session', 'scratch', 'scratch-1', 'scratch-1', ?, ?);
`, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"notifications", "conversations"} {
		var projectID any
		if err := db.QueryRow("SELECT project_id FROM " + table + " LIMIT 1").Scan(&projectID); err != nil {
			t.Fatalf("%s project_id: %v", table, err)
		}
		if projectID != nil {
			t.Fatalf("%s.project_id = %#v, want NULL", table, projectID)
		}
	}
	var workerProjectID any
	if err := db.QueryRow("SELECT project_id FROM sessions WHERE id = 'scratch-1'").Scan(&workerProjectID); err != nil {
		t.Fatal(err)
	}
	if workerProjectID != nil {
		t.Fatalf("standalone worker project_id = %#v, want NULL", workerProjectID)
	}
	var orchestratorProjectID string
	var orchestratorTerminated bool
	var orchestratorActivity string
	if err := db.QueryRow(`SELECT project_id, is_terminated, activity_state FROM sessions WHERE id = 'scratch-2'`).Scan(
		&orchestratorProjectID,
		&orchestratorTerminated,
		&orchestratorActivity,
	); err != nil {
		t.Fatal(err)
	}
	if orchestratorProjectID != "scratch" || !orchestratorTerminated || orchestratorActivity != "exited" {
		t.Fatalf("legacy orchestrator = project %q terminated=%v activity=%q", orchestratorProjectID, orchestratorTerminated, orchestratorActivity)
	}
	var remainingScratchWorkerEvents int
	if err := db.QueryRow("SELECT COUNT(*) FROM change_log WHERE session_id = 'scratch-1' AND project_id = 'scratch'").Scan(&remainingScratchWorkerEvents); err != nil {
		t.Fatal(err)
	}
	if remainingScratchWorkerEvents != 0 {
		t.Fatalf("change_log retains %d Scratch-owned worker events", remainingScratchWorkerEvents)
	}
	var archivedAt any
	if err := db.QueryRow("SELECT archived_at FROM projects WHERE id = 'scratch'").Scan(&archivedAt); err != nil {
		t.Fatal(err)
	}
	if archivedAt == nil {
		t.Fatal("legacy Scratch project was not archived")
	}
}

func TestStandaloneMigrationLeavesRegisteredScratchRepositoryUntouched(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 122)

	const timestamp = "2026-09-02T12:00:00Z"
	if _, err := db.Exec(`
INSERT INTO projects (id, path, display_name, registered_at, kind)
VALUES ('scratch', '/repos/scratch', 'scratch', ?, 'single_repo');
INSERT INTO sessions (id, project_id, num, kind, harness, activity_last_at, created_at, updated_at)
VALUES ('scratch-1', 'scratch', 1, 'worker', 'codex', ?, ?, ?);
`, timestamp, timestamp, timestamp, timestamp); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}

	var projectID string
	var terminated bool
	if err := db.QueryRow("SELECT project_id, is_terminated FROM sessions WHERE id = 'scratch-1'").Scan(&projectID, &terminated); err != nil {
		t.Fatal(err)
	}
	if projectID != "scratch" || terminated {
		t.Fatalf("registered scratch session = project %q terminated=%v", projectID, terminated)
	}
	var archivedAt any
	if err := db.QueryRow("SELECT archived_at FROM projects WHERE id = 'scratch'").Scan(&archivedAt); err != nil {
		t.Fatal(err)
	}
	if archivedAt != nil {
		t.Fatalf("registered scratch project archived_at = %#v, want NULL", archivedAt)
	}
}
