package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestClaudeCodeAccountManagementMigrationRollsBackCleanly(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 125)
	if got := tableColumns(t, db, "claude_code_active_account"); len(got) != 0 {
		t.Fatalf("active-account table exists before migration: %v", got)
	}
	upTo(t, db, 126)
	if got := tableColumns(t, db, "claude_code_active_account"); len(got) == 0 {
		t.Fatal("active-account table missing after migration")
	}
	if got := tableColumns(t, db, "claude_code_account_switches"); len(got) == 0 {
		t.Fatal("account-switch table missing after migration")
	}

	downTo(t, db, 125)
	if got := tableColumns(t, db, "claude_code_active_account"); len(got) != 0 {
		t.Fatalf("active-account table remains after rollback: %v", got)
	}
	if got := tableColumns(t, db, "claude_code_account_switches"); len(got) != 0 {
		t.Fatalf("account-switch table remains after rollback: %v", got)
	}
}
