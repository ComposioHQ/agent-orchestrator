package sqlite

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

func TestMigrateRepairsRenumberedCodexProfileHistory(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 116)
	applyLegacyCodexProfileMigrations(t, db, []legacyCodexProfileMigration{
		{version: 117, canonicalPath: "migrations/0119_drop_agent_inventory_cache.sql", legacyName: "drop_agent_inventory_cache.sql"},
		{version: 118, canonicalPath: "migrations/0120_codex_session_bindings.sql", legacyName: "codex_session_bindings.sql"},
		{version: 119, canonicalPath: "migrations/0121_codex_profile_switches.sql", legacyName: "codex_profile_switches.sql"},
	})
	if _, err := db.Exec(`CREATE TABLE conversation_turns_next AS SELECT * FROM conversation_turns`); err != nil {
		t.Fatalf("seed interrupted conversation-turn migration: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate renumbered Codex profile database: %v", err)
	}

	assertAppliedMigrations(t, db, 117, 118, 119, 120, 121)
	assertTableSQLContains(t, db, "usage_bindings", "'kimi'")
	assertTableSQLContains(t, db, "usage_sources", "'kimi_wire'")
	assertTableSQLContains(t, db, "conversation_turns", "'cancelled'")
	assertTableColumnsPresent(t, db, "codex_session_bindings", "session_id", "profile_id", "profile_source", "codex_home", "created_at")
	assertTableColumnsPresent(t, db, "sessions", "archived_at")
	assertTableColumnsPresent(t, db, "codex_profile_switches", "id", "source_session_id", "target_session_id", "phase", "workspace_owner")
	var stagingTable int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns_next'`).Scan(&stagingTable); err != nil {
		t.Fatalf("read conversation turn staging table: %v", err)
	}
	if stagingTable != 0 {
		t.Fatalf("conversation_turns_next remains after migration recovery")
	}
	var inventoryTable int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_inventory_cache'`).Scan(&inventoryTable); err != nil {
		t.Fatalf("read agent inventory table: %v", err)
	}
	if inventoryTable != 0 {
		t.Fatalf("agent_inventory_cache exists after canonical drop")
	}
	if err := migrate(db); err != nil {
		t.Fatalf("second migration pass: %v", err)
	}
}

type legacyCodexProfileMigration struct {
	version       int64
	canonicalPath string
	legacyName    string
}

func applyLegacyCodexProfileMigrations(t *testing.T, db *sql.DB, migrations []legacyCodexProfileMigration) {
	t.Helper()
	legacyFS := fstest.MapFS{}
	for _, migration := range migrations {
		contents, err := migrationsFS.ReadFile(migration.canonicalPath)
		if err != nil {
			t.Fatalf("read canonical migration %q: %v", migration.canonicalPath, err)
		}
		legacyFS[fmt.Sprintf("migrations/%04d_%s", migration.version, migration.legacyName)] = &fstest.MapFile{Data: contents}
	}

	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(legacyFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set goose dialect: %v", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		t.Fatalf("apply legacy Codex profile migrations: %v", err)
	}
}

func assertAppliedMigrations(t *testing.T, db *sql.DB, versions ...int64) {
	t.Helper()
	for _, version := range versions {
		var applied int
		if err := db.QueryRow(`
SELECT COALESCE((
    SELECT is_applied FROM goose_db_version
    WHERE version_id = ? ORDER BY id DESC LIMIT 1
), 0)`, version).Scan(&applied); err != nil {
			t.Fatalf("read migration %d: %v", version, err)
		}
		if applied != 1 {
			t.Fatalf("migration %d applied = %d, want 1", version, applied)
		}
	}
}

func assertTableSQLContains(t *testing.T, db *sql.DB, table, fragment string) {
	t.Helper()
	var schema string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&schema); err != nil {
		t.Fatalf("read %s schema: %v", table, err)
	}
	if !strings.Contains(schema, fragment) {
		t.Fatalf("%s schema does not contain %q: %s", table, fragment, schema)
	}
}

func assertTableColumnsPresent(t *testing.T, db *sql.DB, table string, columns ...string) {
	t.Helper()
	for _, column := range columns {
		var present int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&present); err != nil {
			t.Fatalf("read %s.%s: %v", table, column, err)
		}
		if present != 1 {
			t.Fatalf("%s.%s count = %d, want 1", table, column, present)
		}
	}
}
