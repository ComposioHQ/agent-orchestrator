package sqlite

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// reconcileTableExists reports whether a table is physically present in the
// database. reconcileSchema's table-level check uses the same probe, so a
// missing table here is exactly the drift reconcile is expected to repair.
func reconcileTableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&count); err != nil {
		t.Fatalf("inspect table %s: %v", name, err)
	}
	return count > 0
}

// reconcileColumnExists reports whether a column is physically present.
func reconcileColumnExists(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column,
	).Scan(&count); err != nil {
		t.Fatalf("inspect %s.%s: %v", table, column, err)
	}
	return count > 0
}

// TestMigrateReconcilesMissingInventoryCacheTable covers a drift that took
// down ao spawn on a real profile: goose_db_version records migration 0104 as
// applied, but the agent_inventory_cache table is physically absent. The
// agent-catalog refresh then 500s, spawn reports INTERNAL_ERROR, and /readyz
// stays green. reconcileSchema must recreate the table on startup (or fail
// loudly) instead of treating the drifted database as healthy.
func TestMigrateReconcilesMissingInventoryCacheTable(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Bring the schema to just before 0104, then burn the version the way a
	// renumbered/skipped migration would: goose will think 0104 already ran
	// and never create the table itself.
	upTo(t, db, 103)
	if _, err := db.Exec(
		`INSERT INTO goose_db_version (version_id, is_applied) VALUES (104, 1)`,
	); err != nil {
		t.Fatalf("burn version 104: %v", err)
	}
	if reconcileTableExists(t, db, "agent_inventory_cache") {
		t.Fatalf("precondition: agent_inventory_cache exists before version 104; the burn was not set up")
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate with version 104 burned: %v", err)
	}
	if !reconcileTableExists(t, db, "agent_inventory_cache") {
		t.Fatalf("agent_inventory_cache missing after migrate: a burned 0104 must be recreated by schema reconciliation, or startup must fail with a specific error instead of 500ing on spawn")
	}
}

// TestMigrateReconcilesMissingPRCommentReviewIDColumn is the column-side
// counterpart: migration 0106 is recorded applied but pr_comment.review_id
// does not exist. preparePRCommentReviewIDMigration only handles the mirror
// case (column physically present, ledger entry missing), so nothing repairs
// this direction unless reconcileSchema knows about the column.
func TestMigrateReconcilesMissingPRCommentReviewIDColumn(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "ao.db")+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 105)
	if _, err := db.Exec(
		`INSERT INTO goose_db_version (version_id, is_applied) VALUES (106, 1)`,
	); err != nil {
		t.Fatalf("burn version 106: %v", err)
	}
	if reconcileColumnExists(t, db, "pr_comment", "review_id") {
		t.Fatalf("precondition: pr_comment.review_id exists before version 106; the burn was not set up")
	}

	if err := migrate(db); err != nil {
		t.Fatalf("migrate with version 106 burned: %v", err)
	}
	if !reconcileColumnExists(t, db, "pr_comment", "review_id") {
		t.Fatalf("pr_comment.review_id missing after migrate: a burned 0106 must be recreated by schema reconciliation")
	}
}
