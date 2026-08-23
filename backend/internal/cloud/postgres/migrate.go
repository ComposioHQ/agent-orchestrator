package postgres

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	// Register pgx as the database/sql driver used by Goose.
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// EnsureRuntimeRole creates the restricted login role used by ao-cloud when a
// deployment initializes a new PostgreSQL instance. Existing roles are never
// altered; they are only validated so a deployment cannot silently elevate or
// rotate a live runtime credential.
func EnsureRuntimeRole(ctx context.Context, databaseURL, runtimeRole, runtimePassword string) error {
	databaseURL = strings.TrimSpace(databaseURL)
	runtimeRole = strings.TrimSpace(runtimeRole)
	if databaseURL == "" || runtimeRole == "" || runtimePassword == "" {
		return errors.New("migration database URL, runtime role, and runtime password are required")
	}
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect for runtime role bootstrap: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	var migrationRole string
	if err := conn.QueryRow(ctx, `SELECT current_user`).Scan(&migrationRole); err != nil {
		return err
	}
	var canLogin, superuser, bypassRLS, createRole, createDB, replication bool
	err = conn.QueryRow(
		ctx,
		`SELECT rolcanlogin, rolsuper, rolbypassrls,
		        rolcreaterole, rolcreatedb, rolreplication
		 FROM pg_roles WHERE rolname = $1`,
		runtimeRole,
	).Scan(&canLogin, &superuser, &bypassRLS, &createRole, &createDB, &replication)
	if err == nil {
		if !canLogin || superuser || bypassRLS || createRole || createDB || replication || runtimeRole == migrationRole {
			return fmt.Errorf("runtime role %q must be a separate, unprivileged login role", runtimeRole)
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	var quotedPassword string
	if err := conn.QueryRow(ctx, `SELECT quote_literal($1)`, runtimePassword).Scan(&quotedPassword); err != nil {
		return fmt.Errorf("quote runtime role password: %w", err)
	}
	statement := "CREATE ROLE " + pgx.Identifier{runtimeRole}.Sanitize() + " LOGIN PASSWORD " + quotedPassword
	if _, err := conn.Exec(ctx, statement); err != nil {
		return fmt.Errorf("create runtime role %q: %w", runtimeRole, err)
	}
	return nil
}

// Migrate applies embedded Cloud migrations with a privileged migration URL,
// then grants the existing restricted runtime role access to the foundation.
func Migrate(ctx context.Context, databaseURL, runtimeRole string) error {
	databaseURL = strings.TrimSpace(databaseURL)
	runtimeRole = strings.TrimSpace(runtimeRole)
	if databaseURL == "" || runtimeRole == "" {
		return errors.New("migration database URL and runtime role are required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration database: %w", err)
	}
	defer func() { _ = db.Close() }()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping migration database: %w", err)
	}
	goose.SetBaseFS(migrationFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("apply cloud migrations: %w", err)
	}
	if err := grantRuntimeRole(ctx, databaseURL, runtimeRole); err != nil {
		return fmt.Errorf("grant cloud runtime role: %w", err)
	}
	return nil
}

func grantRuntimeRole(ctx context.Context, databaseURL, runtimeRole string) error {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	var exists, canLogin, superuser, bypassRLS, createRole, createDB, replication bool
	if err := conn.QueryRow(
		ctx,
		`SELECT true, rolcanlogin, rolsuper, rolbypassrls,
		        rolcreaterole, rolcreatedb, rolreplication
		 FROM pg_roles WHERE rolname = $1`,
		runtimeRole,
	).Scan(&exists, &canLogin, &superuser, &bypassRLS, &createRole, &createDB, &replication); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("runtime role %q does not exist", runtimeRole)
		}
		return err
	}
	var migrationRole string
	if err := conn.QueryRow(ctx, `SELECT current_user`).Scan(&migrationRole); err != nil {
		return err
	}
	if !exists || !canLogin || superuser || bypassRLS || createRole || createDB || replication || runtimeRole == migrationRole {
		return fmt.Errorf("runtime role %q must be a separate, unprivileged login role", runtimeRole)
	}
	role := pgx.Identifier{runtimeRole}.Sanitize()
	var databaseName string
	if err := conn.QueryRow(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil {
		return err
	}
	statements := make([]string, 0, 3+len(runtimeTableGrants))
	statements = append(statements,
		"GRANT CONNECT ON DATABASE "+pgx.Identifier{databaseName}.Sanitize()+" TO "+role,
		"GRANT USAGE ON SCHEMA public TO "+role,
		"GRANT EXECUTE ON FUNCTION public.ao_current_user_id(), public.ao_current_org_id(), public.ao_current_workspace_id(), public.ao_is_org_member(uuid, uuid), public.ao_can_manage_org(uuid, uuid) TO "+role,
	)
	statements = append(statements, runtimeTableGrantStatements(role)...)
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			return err
		}
	}
	if err := grantOwnedFunctions(ctx, conn, "ao_cloud_scm", role, strings.Join([]string{
		"public.ao_scm_upsert_installation(uuid, uuid, bigint, text, text, text, text, text)",
		"public.ao_scm_claim_install_state(bytea, bytea, bigint)",
		"public.ao_scm_get_install_claim(bytea)",
		"public.ao_scm_release_install_claim(bytea)",
		"public.ao_scm_finalize_install_state(bytea)",
		"public.ao_scm_ingest_and_claim_webhook(text, text, text, bytea, text, text)",
		"public.ao_scm_claim_due_webhooks(text, integer)",
		"public.ao_scm_finish_webhook(text, text, uuid, text, text)",
		"public.ao_scm_prune_webhooks(interval)",
		"public.ao_scm_record_observation(text, bigint, text, text, text, integer, text, text)",
	}, ", ")); err != nil {
		return err
	}
	return grantOwnedFunctions(ctx, conn, "ao_cloud_auth", role,
		"public.ao_upsert_google_user(text, text, text), public.ao_rotate_refresh_session(bytea, bytea), public.ao_revoke_refresh_session(bytea)")
}

// grantOwnedFunctions assumes a narrowly privileged NOLOGIN owner only long
// enough to delegate EXECUTE. Neither the migrator nor runtime role owns the
// SECURITY DEFINER functions or receives the owner's table privileges.
func grantOwnedFunctions(ctx context.Context, conn *pgx.Conn, ownerRole, runtimeRole, functions string) error {
	if _, err := conn.Exec(ctx, "SET ROLE "+pgx.Identifier{ownerRole}.Sanitize()); err != nil {
		return err
	}
	_, grantErr := conn.Exec(ctx, "GRANT EXECUTE ON FUNCTION "+functions+" TO "+runtimeRole)
	_, resetErr := conn.Exec(ctx, `RESET ROLE`)
	if grantErr != nil {
		return grantErr
	}
	return resetErr
}
