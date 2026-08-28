package sqlite

import (
	"database/sql"
	"embed"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

// These migrations are frozen verbatim from the published Pipelines feature
// release v0.11.1-pr2863.202607311655. Migrations 0001-0039 are byte-identical
// to main, so applying main through 0039 and this fixture through 0051 produces
// the real foreign migration profile that reached users.
//
//go:embed testdata/pipeline_pr2863_migrations/*.sql
var pipelinePR2863Migrations embed.FS

func TestOpenUpgradesPublishedPipelineProfileWithoutLosingData(t *testing.T) {
	dataDir := t.TempDir()
	seedPublishedPipelineProfile(t, dataDir)

	store, err := Open(dataDir)
	if err != nil {
		t.Fatalf("open published Pipelines profile: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close upgraded store: %v", err)
	}

	db := openPipelineProfileCheckDB(t, dataDir)
	assertPublishedPipelineProfileRetired(t, db)
	if err := db.Close(); err != nil {
		t.Fatalf("close upgraded check database: %v", err)
	}

	// Recovery and ordinary migrations are both idempotent across a real second
	// startup; archived rows must not be duplicated or discarded.
	store, err = Open(dataDir)
	if err != nil {
		t.Fatalf("reopen upgraded Pipelines profile: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close reopened store: %v", err)
	}
	db = openPipelineProfileCheckDB(t, dataDir)
	defer func() { _ = db.Close() }()
	assertPublishedPipelineProfileRetired(t, db)
}

func TestOpenRejectsUnknownPublishedPipelineSettingWithoutMutation(t *testing.T) {
	dataDir := t.TempDir()
	seedPublishedPipelineProfile(t, dataDir)

	db := openPipelineProfileCheckDB(t, dataDir)
	if _, err := db.Exec(
		`INSERT INTO app_settings (key, value) VALUES ('future.feature.enabled', 'true')`,
	); err != nil {
		t.Fatalf("seed unknown legacy setting: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close profile with unknown setting: %v", err)
	}

	store, err := Open(dataDir)
	if err == nil {
		_ = store.Close()
		t.Fatal("open profile with unknown legacy setting succeeded, want fail-closed error")
	}
	if !strings.Contains(err.Error(), "future.feature.enabled") {
		t.Fatalf("open error = %q, want unknown setting key", err)
	}

	db = openPipelineProfileCheckDB(t, dataDir)
	defer func() { _ = db.Close() }()
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, []string{"key", "value"}) {
		t.Fatalf("app_settings columns after rejected recovery = %v, want untouched key/value schema", got)
	}
	assertCount(t, db, `SELECT COUNT(*) FROM app_settings`, 2)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%'`, 5)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'pipeline_%_cdc_%'`, 7)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_ao_legacy_pr2863_app_settings'`, 0)
}

func TestOpenRejectsUnknownPublishedPipelineCDCWithoutMutation(t *testing.T) {
	t.Run("event type", func(t *testing.T) {
		dataDir := t.TempDir()
		seedPublishedPipelineProfile(t, dataDir)
		db := openPipelineProfileCheckDB(t, dataDir)
		if _, err := db.Exec(`
PRAGMA ignore_check_constraints = ON;
INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
VALUES ('legacy-project', NULL, 'pipeline_future_event', '{}', '2026-07-31T17:01:00Z');
PRAGMA ignore_check_constraints = OFF;
`); err != nil {
			_ = db.Close()
			t.Fatalf("seed unknown pipeline event: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("close profile with unknown pipeline event: %v", err)
		}

		store, err := Open(dataDir)
		if err == nil {
			_ = store.Close()
			t.Fatal("open profile with unknown pipeline event succeeded")
		}
		if !strings.Contains(err.Error(), "pipeline_future_event") {
			t.Fatalf("open error = %q, want unknown pipeline event", err)
		}
		assertPublishedPipelineProfileUntouched(t, dataDir)
	})

	t.Run("trigger", func(t *testing.T) {
		dataDir := t.TempDir()
		seedPublishedPipelineProfile(t, dataDir)
		db := openPipelineProfileCheckDB(t, dataDir)
		if _, err := db.Exec(`
CREATE TRIGGER pipeline_custom_cdc
AFTER UPDATE ON sessions
BEGIN
    SELECT 1;
END;
`); err != nil {
			_ = db.Close()
			t.Fatalf("seed unknown pipeline trigger: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("close profile with unknown pipeline trigger: %v", err)
		}

		store, err := Open(dataDir)
		if err == nil {
			_ = store.Close()
			t.Fatal("open profile with unknown pipeline trigger succeeded")
		}
		if !strings.Contains(err.Error(), "pipeline_custom_cdc") {
			t.Fatalf("open error = %q, want unknown pipeline trigger", err)
		}
		assertPublishedPipelineProfileUntouched(t, dataDir)
	})

	t.Run("modified published trigger", func(t *testing.T) {
		dataDir := t.TempDir()
		seedPublishedPipelineProfile(t, dataDir)
		db := openPipelineProfileCheckDB(t, dataDir)
		var definition string
		if err := db.QueryRow(`
SELECT sql FROM sqlite_master
WHERE type = 'trigger' AND name = 'pipeline_runs_cdc_update'`).Scan(&definition); err != nil {
			_ = db.Close()
			t.Fatalf("read published trigger: %v", err)
		}
		modified := strings.TrimSuffix(definition, "END") + "    SELECT 1;\nEND"
		if _, err := db.Exec(`DROP TRIGGER pipeline_runs_cdc_update`); err != nil {
			_ = db.Close()
			t.Fatalf("drop published trigger: %v", err)
		}
		if _, err := db.Exec(modified); err != nil {
			_ = db.Close()
			t.Fatalf("seed modified published trigger: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("close profile with modified published trigger: %v", err)
		}

		store, err := Open(dataDir)
		if err == nil {
			_ = store.Close()
			t.Fatal("open profile with modified published trigger succeeded")
		}
		if !strings.Contains(err.Error(), "pipeline_runs_cdc_update") {
			t.Fatalf("open error = %q, want modified pipeline trigger", err)
		}
		assertPublishedPipelineProfileUntouched(t, dataDir)
	})
}

func TestOpenDoesNotClaimFuturePipelineSchema(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{
			name: "healthy main database",
			setup: func(t *testing.T, dataDir string) {
				store, err := Open(dataDir)
				if err != nil {
					t.Fatalf("create healthy main database: %v", err)
				}
				if err := store.Close(); err != nil {
					t.Fatalf("close healthy main database: %v", err)
				}
			},
		},
		{
			name: "retired published profile",
			setup: func(t *testing.T, dataDir string) {
				seedPublishedPipelineProfile(t, dataDir)
				store, err := Open(dataDir)
				if err != nil {
					t.Fatalf("retire published profile: %v", err)
				}
				if err := store.Close(); err != nil {
					t.Fatalf("close retired published profile: %v", err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			tc.setup(t, dataDir)
			db := openPipelineProfileCheckDB(t, dataDir)
			if _, err := db.Exec(`CREATE TABLE pipeline_future_state (id TEXT PRIMARY KEY)`); err != nil {
				_ = db.Close()
				t.Fatalf("create future pipeline schema: %v", err)
			}
			if err := db.Close(); err != nil {
				t.Fatalf("close future pipeline database: %v", err)
			}

			store, err := Open(dataDir)
			if err != nil {
				t.Fatalf("reopen with future pipeline schema: %v", err)
			}
			if err := store.Close(); err != nil {
				t.Fatalf("close reopened future pipeline database: %v", err)
			}
			db = openPipelineProfileCheckDB(t, dataDir)
			defer func() { _ = db.Close() }()
			assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_future_state'`, 1)
		})
	}
}

func TestOpenRejectsUnrecognizedKeyValueSettingsProfileWithoutMutation(t *testing.T) {
	dataDir := t.TempDir()
	db := openPipelineProfileCheckDB(t, dataDir)
	upTo(t, db, 51)
	if _, err := db.Exec(`
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('pipelines.enabled', 'true');
`); err != nil {
		t.Fatalf("seed unrecognized key/value settings profile: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close unrecognized settings profile: %v", err)
	}

	store, err := Open(dataDir)
	if err == nil {
		_ = store.Close()
		t.Fatal("open unrecognized key/value settings profile succeeded, want fail-closed error")
	}
	if !strings.Contains(err.Error(), "0/4 lineage migrations") {
		t.Fatalf("open error = %q, want missing-lineage diagnostic", err)
	}

	db = openPipelineProfileCheckDB(t, dataDir)
	defer func() { _ = db.Close() }()
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, []string{"key", "value"}) {
		t.Fatalf("app_settings columns after rejected profile = %v, want untouched key/value schema", got)
	}
	assertCount(t, db, `SELECT COUNT(*) FROM app_settings WHERE key = 'pipelines.enabled' AND value = 'true'`, 1)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE name GLOB '_ao_legacy_pr2863_*'`, 0)
}

func TestOpenRollsBackPublishedPipelineRecoveryOnFailure(t *testing.T) {
	dataDir := t.TempDir()
	seedPublishedPipelineProfile(t, dataDir)
	db := openPipelineProfileCheckDB(t, dataDir)
	if _, err := db.Exec(`
CREATE TRIGGER reject_pipeline_profile_recovery_0067
BEFORE INSERT ON goose_db_version
WHEN NEW.version_id = 67
BEGIN
    SELECT RAISE(ABORT, 'forced migration 67 ledger failure');
END;
`); err != nil {
		t.Fatalf("seed recovery failure: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close profile with recovery failure: %v", err)
	}

	store, err := Open(dataDir)
	if err == nil {
		_ = store.Close()
		t.Fatal("open profile with forced recovery failure succeeded")
	}
	if !strings.Contains(err.Error(), "forced migration 67 ledger failure") {
		t.Fatalf("open error = %q, want forced ledger failure", err)
	}

	db = openPipelineProfileCheckDB(t, dataDir)
	defer func() { _ = db.Close() }()
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, []string{"key", "value"}) {
		t.Fatalf("app_settings columns after rollback = %v, want original key/value schema", got)
	}
	assertCount(t, db, `SELECT COUNT(*) FROM app_settings WHERE key = 'pipelines.enabled' AND value = 'true'`, 1)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%'`, 5)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'pipeline_%_cdc_%'`, 7)
	assertCount(t, db, `SELECT COUNT(*) FROM change_log WHERE event_type LIKE 'pipeline_%'`, 3)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE name GLOB '_ao_legacy_pr2863_*'`, 0)
}

func assertPublishedPipelineProfileUntouched(t *testing.T, dataDir string) {
	t.Helper()
	db := openPipelineProfileCheckDB(t, dataDir)
	defer func() { _ = db.Close() }()
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, []string{"key", "value"}) {
		t.Fatalf("app_settings columns after rejected recovery = %v, want untouched key/value schema", got)
	}
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%'`, 5)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name GLOB '_ao_legacy_pr2863_*'`, 0)
}

func seedPublishedPipelineProfile(t *testing.T, dataDir string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open seed database: %v", err)
	}
	db.SetMaxOpenConns(1)
	upTo(t, db, 39)
	applyPublishedPipelineMigrations(t, db)

	if _, err := db.Exec(`
INSERT INTO projects (id, path, registered_at)
VALUES ('legacy-project', '/repos/legacy-project', '2026-07-31T16:55:00Z');

INSERT INTO sessions (
    id, project_id, num, activity_last_at, created_at, updated_at
) VALUES (
    'legacy-project-1', 'legacy-project', 1,
    '2026-07-31T16:55:01Z', '2026-07-31T16:55:01Z', '2026-07-31T16:55:01Z'
);

INSERT INTO app_settings (key, value) VALUES ('pipelines.enabled', 'true');

INSERT INTO pipeline_definitions (
    id, project_id, name, yaml_source, config_json, created_at, updated_at
) VALUES (
    'pipeline-1', 'legacy-project', 'Release', 'stages: []', '{}',
    '2026-07-31T16:56:00Z', '2026-07-31T16:56:00Z'
);

INSERT INTO pipeline_runs (
    id, project_id, pipeline_id, pipeline_name, subject_kind, session_id,
    status, definition_json, created_at, updated_at, run_number
) VALUES (
    'run-1', 'legacy-project', 'pipeline-1', 'Release', 'session',
    'legacy-project-1', 'running', '{}',
    '2026-07-31T16:57:00Z', '2026-07-31T16:57:00Z', 1
);

INSERT INTO pipeline_stage_runs (
    run_id, project_id, stage_id, outcome, session_id, started_at, pgid
) VALUES (
    'run-1', 'legacy-project', 'review', 'running', 'legacy-project-1',
    '2026-07-31T16:58:00Z', 4242
);

INSERT INTO pipeline_stage_signals (run_id, stage_id, kind, reason, created_at)
VALUES ('run-1', 'review', 'done', 'approved', '2026-07-31T16:59:00Z');

INSERT INTO pipeline_credentials (
    project_id, name, env_json, created_at, updated_at
) VALUES (
    'legacy-project', 'release-token', '{"TOKEN":"secret"}',
    '2026-07-31T17:00:00Z', '2026-07-31T17:00:00Z'
);
`); err != nil {
		_ = db.Close()
		t.Fatalf("seed published Pipelines data: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close seeded published profile: %v", err)
	}
}

func applyPublishedPipelineMigrations(t *testing.T, db *sql.DB) {
	t.Helper()
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(pipelinePR2863Migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set legacy migration dialect: %v", err)
	}
	if err := goose.UpTo(db, "testdata/pipeline_pr2863_migrations", 51); err != nil {
		t.Fatalf("apply published Pipelines migrations: %v", err)
	}
}

func openPipelineProfileCheckDB(t *testing.T, dataDir string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open profile check database: %v", err)
	}
	db.SetMaxOpenConns(1)
	return db
}

func assertPublishedPipelineProfileRetired(t *testing.T, db *sql.DB) {
	t.Helper()
	if got := tableColumns(t, db, "app_settings"); !reflect.DeepEqual(got, []string{"id", "default_session_mode", "updated_at"}) {
		t.Fatalf("canonical app_settings columns = %v", got)
	}
	var mode string
	if err := db.QueryRow(`SELECT default_session_mode FROM app_settings WHERE id = 1`).Scan(&mode); err != nil {
		t.Fatalf("read canonical default mode: %v", err)
	}
	if mode != "chat" {
		t.Fatalf("canonical default mode = %q, want chat", mode)
	}

	var pipelineEnabled string
	if err := db.QueryRow(`
SELECT value FROM _ao_legacy_pr2863_app_settings
WHERE key = 'pipelines.enabled'`).Scan(&pipelineEnabled); err != nil {
		t.Fatalf("read archived pipeline setting: %v", err)
	}
	if pipelineEnabled != "true" {
		t.Fatalf("archived pipelines.enabled = %q, want true", pipelineEnabled)
	}

	for table, want := range map[string]int{
		"_ao_legacy_pr2863_pipeline_definitions":   1,
		"_ao_legacy_pr2863_pipeline_runs":          1,
		"_ao_legacy_pr2863_pipeline_stage_runs":    1,
		"_ao_legacy_pr2863_pipeline_stage_signals": 1,
		"_ao_legacy_pr2863_pipeline_credentials":   1,
	} {
		assertCount(t, db, `SELECT COUNT(*) FROM `+quoteSQLiteIdent(table), want)
	}
	var envJSON string
	if err := db.QueryRow(`SELECT env_json FROM _ao_legacy_pr2863_pipeline_credentials`).Scan(&envJSON); err != nil {
		t.Fatalf("read archived credential: %v", err)
	}
	if envJSON != `{"TOKEN":"secret"}` {
		t.Fatalf("archived credential payload = %q", envJSON)
	}

	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%'`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'pipeline_%_cdc_%'`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM change_log WHERE event_type LIKE 'pipeline_%'`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM _ao_legacy_pr2863_change_log`, 3)
	assertCount(t, db, `SELECT COUNT(*) FROM _ao_legacy_pr2863_recovery WHERE profile_id = 'v0.11.1-pr2863.202607311655'`, 1)
	assertCount(t, db, `SELECT COUNT(*) FROM change_log WHERE event_type = 'session_created'`, 1)
	assertCount(t, db, `SELECT COUNT(*) FROM goose_db_version WHERE version_id = 67 AND is_applied = 1`, 1)
	assertCount(t, db, `SELECT COUNT(*) FROM goose_db_version WHERE version_id = 103 AND is_applied = 1`, 1)

	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		t.Fatalf("run integrity check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want ok", integrity)
	}
	assertCount(t, db, `SELECT COUNT(*) FROM pragma_foreign_key_check`, 0)
}

func assertCount(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	if got != want {
		t.Fatalf("count query %q = %d, want %d", query, got, want)
	}
}
