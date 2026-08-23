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
	scmOptions, err := buildSCM(cfg, store, logger)
	if err != nil {
		return err
	}
	api, err := httpapi.New(httpapi.Options{
		Store:               store,
		Google:              google,
		AllowedEmails:       cfg.AllowedEmails,
		AccessTokens:        accessTokens,
		RefreshTokenTTL:     cfg.RefreshTokenTTL,
		TrustSourceIPHeader: cfg.TrustSourceIPHeader,
		SCM:                 scmOptions,
		Logger:              logger,
	})
	if err != nil {
		return err
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

// buildSCM wires the GitHub App credential boundary when one is configured. A
// deployment without a GitHub App runs without cloud SCM rather than failing
// to start; a misconfigured one fails loudly.
func buildSCM(
	cfg cloudconfig.Config,
	store *cloudpostgres.Store,
	logger *slog.Logger,
) (httpapi.SCMOptions, error) {
	if !cfg.GitHubApp.Configured() {
		logger.Info("Cloud SCM disabled", "reason", "no github app configured")
		return httpapi.SCMOptions{}, nil
	}
	bundle, err := cloudscm.NewBundle(cloudscm.BundleOptions{
		AppID:             cfg.GitHubApp.AppID,
		AppSlug:           cfg.GitHubApp.AppSlug,
		PrivateKeyPEM:     cfg.GitHubApp.PrivateKeyPEM,
		WebhookSecret:     cfg.GitHubApp.WebhookSecret,
		OAuthClientID:     cfg.GitHubApp.OAuthClientID,
		OAuthClientSecret: cfg.GitHubApp.OAuthClientSecret,
		APIBase:           cfg.GitHubApp.APIBase,
		WebBase:           cfg.GitHubApp.WebBase,
		Store:             store,
	})
	if err != nil {
		return httpapi.SCMOptions{}, err
	}
	options := httpapi.SCMOptions{
		Link:                 bundle.Link,
		InstallCompletionURL: cfg.GitHubApp.InstallCompletionURL,
	}
	if bundle.Webhook != nil {
		options.Webhook = bundle.Webhook
	}
	logger.Info(
		"Cloud SCM enabled",
		"app_slug", cfg.GitHubApp.AppSlug,
		"webhooks", bundle.Webhook != nil,
		"user_authorization", bundle.App.RequiresUserAuthorization(),
	)
	return options, nil
}
