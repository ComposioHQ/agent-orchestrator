package sqlite

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMigration0103DropsLegacyPipelineCDCTriggers(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 102)

	// A short-lived pipeline branch created CDC triggers under a burned migration
	// number. Those triggers keep referencing change_log when 0103 rebuilds it.
	if _, err := db.Exec(`
CREATE TABLE pipeline_definitions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    yaml_source TEXT NOT NULL,
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    created_at  TIMESTAMP NOT NULL,
    updated_at  TIMESTAMP NOT NULL
);
CREATE TRIGGER pipeline_definitions_cdc_insert
AFTER INSERT ON pipeline_definitions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'pipeline_definition_changed',
        json_object('id', NEW.id, 'name', NEW.name, 'change', 'created'),
        NEW.updated_at);
END;
`); err != nil {
		t.Fatalf("seed legacy pipeline trigger: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate database with legacy pipeline CDC trigger: %v", err)
	}

	var triggerCount, applied103 int
	if err := db.QueryRow(`
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'trigger' AND name = 'pipeline_definitions_cdc_insert'`).Scan(&triggerCount); err != nil {
		t.Fatalf("read legacy trigger count: %v", err)
	}
	if err := db.QueryRow(`
SELECT COUNT(*) FROM goose_db_version
WHERE version_id = 103 AND is_applied = 1`).Scan(&applied103); err != nil {
		t.Fatalf("read migration 103 ledger: %v", err)
	}
	if triggerCount != 0 || applied103 != 1 {
		t.Fatalf("legacy trigger count = %d, applied 103 entries = %d; want 0, 1", triggerCount, applied103)
	}
}

func TestMigrateRepairsLegacyKeyValueAppSettings(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 66)

	if _, err := db.Exec(`
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('default_session_mode', 'tui');
INSERT INTO goose_db_version (version_id, is_applied) VALUES (67, 1);
`); err != nil {
		t.Fatalf("seed legacy key/value app settings: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate database with legacy app settings: %v", err)
	}

	wantColumns := []string{"id", "default_session_mode", "updated_at"}
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, wantColumns) {
		t.Fatalf("app_settings columns = %v, want %v", got, wantColumns)
	}

	var mode string
	if err := db.QueryRow(`SELECT default_session_mode FROM app_settings WHERE id = 1`).Scan(&mode); err != nil {
		t.Fatalf("read repaired default session mode: %v", err)
	}
	if mode != "chat" {
		t.Fatalf("default session mode = %q, want chat after 0105", mode)
	}
}
