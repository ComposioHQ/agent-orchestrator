package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/auth"
	"github.com/Untrivial-ai/ao-cloud/internal/config"
	"github.com/Untrivial-ai/ao-cloud/internal/httpapi"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("ao-cloud stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer cancel()

	if err := postgres.Migrate(ctx, cfg.MigrationDatabaseURL); err != nil {
		return err
	}
	store, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	if cfg.Hosted() {
		if err := store.ValidateRuntimeRole(ctx); err != nil {
			return err
		}
	}

	var workosVerifier auth.WorkOSVerifier
	if cfg.WorkOSIssuer != "" {
		profiles, err := auth.NewWorkOSProfileResolver(cfg.WorkOSAPIKey, nil)
		if err != nil {
			return err
		}
		organizations, err := auth.NewWorkOSOrganizationResolver(cfg.WorkOSAPIKey, nil)
		if err != nil {
			return err
		}
		workosVerifier, err = auth.NewOIDCVerifier(
			ctx,
			cfg.WorkOSIssuer,
			cfg.WorkOSClientID,
			cfg.WorkOSJWKSURL,
			profiles,
			organizations,
		)
		if err != nil {
			return err
		}
	}
	api := httpapi.New(httpapi.Options{
		Store:            store,
		WorkOS:           workosVerifier,
		LocalAuthEnabled: cfg.LocalAuthEnabled,
		LocalSessionTTL:  cfg.LocalSessionTTL,
		SandboxProvider:  cfg.SandboxProvider,
		Environment:      cfg.Environment,
		Release:          cfg.Release,
		Logger:           logger,
	})
	server := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       90 * time.Second,
	}
	result := make(chan error, 1)
	go func() {
		logger.Info("ao-cloud listening", "config", cfg.String())
		result <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		api.SetDraining(true)
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return nil
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
