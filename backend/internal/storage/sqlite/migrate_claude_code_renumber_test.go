package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

func TestMigrateRecognizesPreRenumberedClaudeCodeAccountSchema(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 124)

	migration, err := migrationsFS.ReadFile("migrations/0126_claude_code_account_management.sql")
	if err != nil {
		t.Fatalf("read Claude Code migration: %v", err)
	}
	func() {
		gooseMu.Lock()
		defer gooseMu.Unlock()
		goose.SetBaseFS(fstest.MapFS{
			"migrations/0125_claude_code_account_management.sql": &fstest.MapFile{Data: migration},
		})
		goose.SetLogger(goose.NopLogger())
		if err := goose.SetDialect("sqlite3"); err != nil {
			t.Fatalf("set goose dialect: %v", err)
		}
		if err := goose.Up(db, "migrations"); err != nil {
			t.Fatalf("apply pre-renumbered Claude Code migration: %v", err)
		}
	}()

	if _, err := db.Exec(`
INSERT INTO claude_code_active_account (
    singleton_id, account_id, revision, activated_at, updated_at
) VALUES (1, 'account-a', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`); err != nil {
		t.Fatalf("seed Claude Code account state: %v", err)
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate pre-renumbered Claude Code database: %v", err)
	}

	var accountID string
	var revision int
	if err := db.QueryRow(`
SELECT account_id, revision FROM claude_code_active_account WHERE singleton_id = 1`).Scan(&accountID, &revision); err != nil {
		t.Fatalf("read preserved Claude Code account state: %v", err)
	}
	if accountID != "account-a" || revision != 7 {
		t.Fatalf("preserved account = %q revision %d, want account-a revision 7", accountID, revision)
	}
	if got := tableColumns(t, db, "agent_switches"); !containsString(got, "failure_point") {
		t.Fatalf("main migration 0125 was not applied: agent_switches columns = %v", got)
	}
	for _, version := range []int64{125, 126} {
		var applied int
		if err := db.QueryRow(`
SELECT COALESCE((SELECT is_applied FROM goose_db_version WHERE version_id = ? ORDER BY id DESC LIMIT 1), 0)`, version).Scan(&applied); err != nil {
			t.Fatalf("read migration %d: %v", version, err)
		}
		if applied != 1 {
			t.Fatalf("migration %d applied = %d, want 1", version, applied)
		}
	}
	if err := migrate(db); err != nil {
		t.Fatalf("second migration pass: %v", err)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
