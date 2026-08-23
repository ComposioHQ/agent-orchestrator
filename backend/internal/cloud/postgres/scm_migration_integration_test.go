package postgres

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

func TestSCMDefinerRoleCannotCreateAfterEachMigration(t *testing.T) {
	migrationURL := strings.TrimSpace(os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL"))
	if migrationURL == "" {
		t.Skip("set AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, migrationURL)
	if err != nil {
		t.Fatal(err)
	}
	databaseName := "ao_scm_priv_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer func() { _ = admin.Close(context.Background()) }()
		_, cleanupErr := admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
		if cleanupErr != nil {
			t.Errorf("drop migration-state database: %v", cleanupErr)
		}
	})
	parsed, err := url.Parse(migrationURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + databaseName
	db, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	goose.SetBaseFS(migrationFS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int64{30, 31, 32} {
		if err := goose.UpToContext(ctx, db, "migrations", version); err != nil {
			t.Fatalf("migrate through %d: %v", version, err)
		}
		var canCreate bool
		if err := db.QueryRowContext(ctx,
			`SELECT has_schema_privilege('ao_cloud_scm', 'public', 'CREATE')`,
		).Scan(&canCreate); err != nil {
			t.Fatalf("inspect ao_cloud_scm after %d: %v", version, err)
		}
		if canCreate {
			t.Fatalf("ao_cloud_scm retains CREATE on public after migration %d", version)
		}
	}
}
