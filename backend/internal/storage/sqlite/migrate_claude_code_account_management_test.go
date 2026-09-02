package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

func TestClaudeCodeAccountManagementMigrationRollsBackCleanly(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	migration, err := migrationsFS.ReadFile("migrations/0126_claude_code_account_management.sql")
	if err != nil {
		t.Fatalf("read Claude Code account migration: %v", err)
	}
	isolatedFS := fstest.MapFS{
		"migrations/0126_claude_code_account_management.sql": &fstest.MapFile{Data: migration},
	}

	gooseMu.Lock()
	t.Cleanup(gooseMu.Unlock)
	goose.SetBaseFS(isolatedFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set goose dialect: %v", err)
	}

	if got := tableColumns(t, db, "claude_code_active_account"); len(got) != 0 {
		t.Fatalf("active-account table exists before migration: %v", got)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		t.Fatalf("apply Claude Code account migration: %v", err)
	}
	if got := tableColumns(t, db, "claude_code_active_account"); len(got) == 0 {
		t.Fatal("active-account table missing after migration")
	}
	if got := tableColumns(t, db, "claude_code_account_switches"); len(got) == 0 {
		t.Fatal("account-switch table missing after migration")
	}

	if err := goose.Down(db, "migrations"); err != nil {
		t.Fatalf("roll back Claude Code account migration: %v", err)
	}
	if got := tableColumns(t, db, "claude_code_active_account"); len(got) != 0 {
		t.Fatalf("active-account table remains after rollback: %v", got)
	}
	if got := tableColumns(t, db, "claude_code_account_switches"); len(got) != 0 {
		t.Fatalf("account-switch table remains after rollback: %v", got)
	}
}
