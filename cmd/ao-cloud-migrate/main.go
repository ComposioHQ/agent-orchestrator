package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	databaseURL := strings.TrimSpace(os.Getenv("AO_CLOUD_MIGRATION_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("AO_CLOUD_DATABASE_URL"))
	}
	if databaseURL == "" {
		logger.Error("migration database URL is required")
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer cancel()
	if err := postgres.Migrate(ctx, databaseURL); err != nil {
		if !errors.Is(err, context.Canceled) {
			logger.Error("migrate AO Cloud database", "error", err)
		}
		os.Exit(1)
	}
	logger.Info("AO Cloud database migrations complete")
}
