package scm

import (
	"errors"
	"net/http"
	"strings"
)

// BundleStore is the complete PostgreSQL boundary used by SCM services.
type BundleStore interface {
	LinkStore
	BrokerStore
	WebhookStore
	ObservationSink
}

// Bundle is the fully composed production GitHub App boundary.
type Bundle struct {
	Link                 *InstallationService
	Broker               *Broker
	Webhook              *WebhookProcessor
	InstallCompletionURL string
}

// BundleOptions supplies validated configuration and production dependencies.
type BundleOptions struct {
	Config     Config
	Store      BundleStore
	HTTPClient *http.Client
}

// NewBundle composes GitHub linking, credential minting, and webhook processing.
func NewBundle(options BundleOptions) (*Bundle, error) {
	if err := options.Config.Validate(); err != nil {
		return nil, err
	}
	if !options.Config.Enabled() {
		return nil, ErrNotConfigured
	}
	if options.Store == nil {
		return nil, errors.New("cloud scm: bundle requires a store")
	}
	credentials, err := NewAppCredentials(options.Config.AppID, options.Config.AppSlug, options.Config.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	app, err := NewAppClient(AppClientOptions{
		Credentials: credentials, HTTPClient: options.HTTPClient,
		APIBase: options.Config.APIBase, WebBase: options.Config.WebBase,
		OAuthClientID:     options.Config.OAuthClientID,
		OAuthClientSecret: options.Config.OAuthClientSecret,
	})
	if err != nil {
		return nil, err
	}
	link, err := NewLinkService(app, options.Store)
	if err != nil {
		return nil, err
	}
	broker, err := NewBroker(options.Store, app)
	if err != nil {
		return nil, err
	}
	webhook, err := NewWebhookProcessor(options.Config.WebhookSecret, options.Store, options.Store)
	if err != nil {
		return nil, err
	}
	return &Bundle{
		Link: link, Broker: broker, Webhook: webhook,
		InstallCompletionURL: strings.TrimSpace(options.Config.InstallCompletionURL),
	}, nil
}

// NewBundleFromEnv is the production environment composition entry point.
func NewBundleFromEnv(store BundleStore, httpClient *http.Client) (*Bundle, error) {
	config, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	defer zeroBytes(config.PrivateKeyPEM)
	defer zeroBytes(config.WebhookSecret)
	return NewBundle(BundleOptions{Config: config, Store: store, HTTPClient: httpClient})
}
