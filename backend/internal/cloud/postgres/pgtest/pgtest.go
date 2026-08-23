// Package pgtest provisions isolated, fully migrated PostgreSQL databases for
// the hosted control plane's tests.
//
// Every call to New creates its own database rather than reusing one. The
// cloud schema is global — one public schema, one set of roles, one goose
// version table — so sharing a database between tests makes them order
// dependent, which is exactly how the first account-store integration test
// started passing on a clean database and failing on a second run.
//
// Tests skip when no PostgreSQL is configured. See doc.go in this directory for
// how to start a labeled container for a session.
package pgtest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

// Environment variables that point the suite at a PostgreSQL instance.
const (
	// MigrationURLEnv is a libpq URL for the privileged migration role. The role
	// must own the schema it migrates and be able to CREATE DATABASE, because
	// each test gets its own.
	MigrationURLEnv = "AO_CLOUD_TEST_MIGRATION_DATABASE_URL"
	// RuntimeRoleEnv names the restricted login role ao-cloud itself uses. It
	// must not be the migration role.
	RuntimeRoleEnv = "AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE"
	// RuntimePasswordEnv names the variable holding that role's password. It
	// defaults to a fixed local test value, since the databases this package
	// creates are disposable and dropped when the test ends.
	RuntimePasswordEnv = "AO_CLOUD_TEST_RUNTIME_DATABASE_PASSWORD" //nolint:gosec // an env var name, not a credential
)

const defaultRuntimePassword = "integration-runtime-password"

var pendingCoreTables = []string{
	"ao_projects",
	"ao_sessions",
	"ao_session_worktrees",
}

// databaseCounter keeps names unique within one test binary; the process id
// keeps them unique across concurrently running packages.
var databaseCounter atomic.Int64

// Config is a resolved PostgreSQL target.
type Config struct {
	MigrationURL    string
	RuntimeRole     string
	RuntimePassword string
}

// Configured reports the environment's PostgreSQL target, if any.
func Configured() (Config, bool) {
	cfg := Config{
		MigrationURL:    strings.TrimSpace(os.Getenv(MigrationURLEnv)),
		RuntimeRole:     strings.TrimSpace(os.Getenv(RuntimeRoleEnv)),
		RuntimePassword: strings.TrimSpace(os.Getenv(RuntimePasswordEnv)),
	}
	if cfg.MigrationURL == "" || cfg.RuntimeRole == "" {
		return Config{}, false
	}
	if cfg.RuntimePassword == "" {
		cfg.RuntimePassword = defaultRuntimePassword
	}
	return cfg, true
}

// New returns a store connected to a freshly created, fully migrated database
// as the restricted runtime role, and skips the test when no PostgreSQL target
// is configured. The database is dropped when the test finishes.
func New(t *testing.T) *postgres.Store {
	t.Helper()
	return NewWithTables(t, nil)
}

// NewWithTables behaves like New and additionally grants the restricted test
// runtime role access to tables whose centralized runtime registration belongs
// to another integration stack. Names are quoted as PostgreSQL identifiers;
// callers pass unqualified table names in the public schema.
func NewWithTables(t *testing.T, additionalTables []string) *postgres.Store {
	t.Helper()
	cfg, ok := Configured()
	if !ok {
		t.Skipf("set %s and %s to run PostgreSQL tests", MigrationURLEnv, RuntimeRoleEnv)
	}
	ctx := context.Background()

	name := fmt.Sprintf("ao_cloud_test_%d_%d", os.Getpid(), databaseCounter.Add(1))
	if err := createDatabase(ctx, cfg.MigrationURL, name); err != nil {
		t.Fatalf("create test database %s: %v", name, err)
	}
	t.Cleanup(func() {
		if err := dropDatabase(context.Background(), cfg.MigrationURL, name); err != nil {
			t.Errorf("drop test database %s: %v", name, err)
		}
	})

	migrationURL, err := withDatabase(cfg.MigrationURL, name)
	if err != nil {
		t.Fatalf("build migration URL: %v", err)
	}
	if err := postgres.EnsureRuntimeRole(ctx, migrationURL, cfg.RuntimeRole, cfg.RuntimePassword); err != nil {
		t.Fatalf("ensure runtime role: %v", err)
	}
	if err := postgres.Migrate(ctx, migrationURL, cfg.RuntimeRole); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// Core table registration is intentionally owned by the integration branch.
	// Grant the exact pending tables in isolated test databases so this package
	// can verify their RLS and adapter behavior before that central placement.
	if err := grantPendingTables(ctx, migrationURL, cfg.RuntimeRole, additionalTables); err != nil {
		t.Fatalf("grant pending runtime tables: %v", err)
	}

	runtimeURL, err := asRole(migrationURL, cfg.RuntimeRole, cfg.RuntimePassword)
	if err != nil {
		t.Fatalf("build runtime URL: %v", err)
	}
	store, err := postgres.Open(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("open runtime store: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func grantPendingTables(ctx context.Context, migrationURL, runtimeRole string, additionalTables []string) error {
	conn, err := pgx.Connect(ctx, migrationURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	role := pgx.Identifier{runtimeRole}.Sanitize()
	tables, err := qualifiedPendingTables(additionalTables)
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx,
		"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "+strings.Join(tables, ", ")+" TO "+role,
	)
	return err
}

func qualifiedPendingTables(additionalTables []string) ([]string, error) {
	tables := make([]string, 0, len(pendingCoreTables)+len(additionalTables))
	seen := make(map[string]struct{}, cap(tables))
	allTables := append(append([]string{}, pendingCoreTables...), additionalTables...)
	for _, table := range allTables {
		table = strings.TrimSpace(table)
		if table == "" {
			return nil, fmt.Errorf("pending runtime table name is empty")
		}
		if _, ok := seen[table]; ok {
			continue
		}
		seen[table] = struct{}{}
		tables = append(tables, pgx.Identifier{"public", table}.Sanitize())
	}
	return tables, nil
}

func createDatabase(ctx context.Context, adminURL, name string) error {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	// CREATE DATABASE takes no parameters, so the name is interpolated. It is
	// built from the process id and a counter in this file, never from input.
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	return err
}

func dropDatabase(ctx context.Context, adminURL, name string) error {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	// A pooled connection can outlive the test that opened it by a few
	// milliseconds; FORCE detaches those rather than failing the cleanup.
	_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	return err
}

func withDatabase(rawURL, database string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parsed.Path = "/" + database
	return parsed.String(), nil
}

func asRole(rawURL, role, password string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parsed.User = url.UserPassword(role, password)
	return parsed.String(), nil
}
