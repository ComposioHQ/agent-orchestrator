package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/auth"
	"github.com/Untrivial-ai/ao-cloud/internal/config"
	"github.com/Untrivial-ai/ao-cloud/internal/githubapp"
	"github.com/Untrivial-ai/ao-cloud/internal/httpapi"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/Untrivial-ai/ao-cloud/internal/reconcile"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox/createos"
	"github.com/Untrivial-ai/ao-cloud/internal/sandboxresolve"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

// readSSHPubKeys loads the operator SSH keys authorized on every sandbox. They
// are a debugging affordance, not part of the worker's trust path.
func readSSHPubKeys(path string) ([]string, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read sandbox SSH public keys %s: %w", path, err)
	}
	var keys []string
	for _, line := range strings.Split(string(raw), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			keys = append(keys, trimmed)
		}
	}
	return keys, nil
}

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

	if cfg.MigrateOnStartup {
		err := func() error {
			migrationContext, cancelMigration := context.WithTimeout(
				ctx,
				cfg.MigrationTimeout,
			)
			defer cancelMigration()
			return postgres.Migrate(migrationContext, cfg.MigrationDatabaseURL)
		}()
		if err != nil {
			return err
		}
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
	var githubService *githubapp.Service
	if cfg.GitHub.Enabled() {
		githubClient, err := githubapp.New(githubapp.Config{
			AppID:         cfg.GitHub.AppID,
			AppSlug:       cfg.GitHub.AppSlug,
			ClientID:      cfg.GitHub.ClientID,
			ClientSecret:  cfg.GitHub.ClientSecret,
			PrivateKeyPEM: cfg.GitHub.PrivateKeyPEM,
			PublicURL:     cfg.GitHub.PublicURL,
		}, nil)
		if err != nil {
			return err
		}
		githubService, err = githubapp.NewService(
			store,
			githubClient,
			cfg.GitHub.StateKey,
			cfg.GitHub.WebhookSecret,
			cfg.GitHub.InstallTTL,
			logger,
		)
		if err != nil {
			return err
		}
		go githubService.Run(ctx)
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
		GitHub:           githubService,
		WebhookMaxBody:   cfg.GitHub.WebhookMaxBody,
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

	if reconciler != nil {
		go func() {
			logger.Info("sandbox reconciler started",
				"provider", cfg.SandboxProvider,
				"interval", cfg.ReconcileInterval,
				"startup_timeout", cfg.SandboxStartupTimeout,
				"heartbeat_timeout", cfg.WorkerHeartbeatTimeout,
			)
			if err := reconciler.Run(ctx); err != nil {
				logger.Error("sandbox reconciler stopped", "error", err)
			}
		}()
	}

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
