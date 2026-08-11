package postgres

import (
	"context"
	"database/sql"
	"embed"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	lockConnection, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer lockConnection.Close()
	if _, err := lockConnection.ExecContext(
		ctx,
		`SELECT pg_advisory_lock(hashtextextended('ao-cloud-migrations', 0))`,
	); err != nil {
		return fmt.Errorf("lock database migrations: %w", err)
	}
	defer func() {
		_, _ = lockConnection.ExecContext(
			context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended('ao-cloud-migrations', 0))`,
		)
	}()

	goose.SetBaseFS(migrationFiles)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	return nil
}
