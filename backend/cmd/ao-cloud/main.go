// Command ao-cloud runs the hosted AO control-plane API.
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

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	cloudconfig "github.com/aoagents/agent-orchestrator/backend/internal/cloud/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/httpapi"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudscm "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("Cloud control plane stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := cloudconfig.Load()
	if err != nil {
		return err
	}
	store, err := cloudpostgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	google, err := auth.NewGoogleVerifier(ctx, cfg.GoogleIssuer, cfg.GoogleJWKSURL, cfg.GoogleClientIDs)
	if err != nil {
		return err
	}
	accessTokens, err := auth.NewAccessTokenManager(
		cfg.AccessTokenKey,
		cfg.AccessTokenIssuer,
		cfg.AccessTokenAudience,
		cfg.AccessTokenTTL,
	)
	if err != nil {
		return err
	}
	var scmOptions httpapi.SCMOptions
	scmBundle, err := cloudscm.NewBundleFromEnv(store, nil)
	if err != nil && !errors.Is(err, cloudscm.ErrNotConfigured) {
		return err
	}
	if scmBundle != nil {
		scmOptions = httpapi.SCMOptions{
			Link: scmBundle.Link, Webhook: scmBundle.Webhook,
			InstallCompletionURL: scmBundle.InstallCompletionURL,
		}
	}
	api, err := httpapi.New(httpapi.Options{
		Store:               store,
		Google:              google,
		AllowedEmails:       cfg.AllowedEmails,
		AccessTokens:        accessTokens,
		RefreshTokenTTL:     cfg.RefreshTokenTTL,
		TrustSourceIPHeader: cfg.TrustSourceIPHeader,
		Logger:              logger,
		App:                 buildAppAPI(cfg, logger),
		SCM:                 scmOptions,
	})
	if err != nil {
		return err
	}
	if scmBundle != nil {
		go runSCMWebhookRetries(ctx, logger, scmBundle.Webhook)
	}
	server := &http.Server{
		Addr:              cfg.Address,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("Cloud control plane listening", "address", cfg.Address)
		errCh <- server.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func runSCMWebhookRetries(ctx context.Context, logger *slog.Logger, processor *cloudscm.WebhookProcessor) {
	const batchSize = 50
	retry := func() {
		processed, err := processor.RetryPending(ctx, batchSize)
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("Cloud SCM webhook retry failed", "error", err)
			return
		}
		if processed > 0 {
			logger.Info("Cloud SCM webhook retries processed", "deliveries", processed)
		}
	}
	retry()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			retry()
		}
	}
}
