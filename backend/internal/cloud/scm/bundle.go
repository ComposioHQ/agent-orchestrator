package scm

import (
	"errors"
	"net/http"
)

// BundleStore is the complete persistence boundary used by SCM application
// services. The concrete PostgreSQL store satisfies it without transport
// dependencies flowing into this package.
type BundleStore interface {
	LinkStore
	BrokerStore
	WebhookStore
}

// Bundle is the production GitHub App boundary. Broker is exposed as the
// CredentialIssuer consumed by sandbox bootstrap; credential bytes are never
// exposed through the HTTP admin API.
type Bundle struct {
	Config  Config
	App     *AppClient
	Link    *LinkService
	Broker  *Broker
	Webhook *WebhookProcessor
}

// BundleOptions configures the production GitHub App boundary.
type BundleOptions struct {
	Config     Config
	Store      BundleStore
	Sink       ObservationSink
	HTTPClient *http.Client
}

// NewBundle validates configuration and constructs SCM application services.
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
		Credentials:       credentials,
		HTTPClient:        options.HTTPClient,
		APIBase:           options.Config.APIBase,
		WebBase:           options.Config.WebBase,
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
	broker, err := NewBroker(app, options.Store)
	if err != nil {
		return nil, err
	}
	bundle := &Bundle{Config: options.Config, App: app, Link: link, Broker: broker}
	if options.Config.WebhooksEnabled() {
		bundle.Webhook, err = NewWebhookProcessor(options.Config.WebhookSecret, options.Store, options.Sink)
		if err != nil {
			return nil, err
		}
	}
	return bundle, nil
}

// NewBundleFromEnv is the production composition entry point.
func NewBundleFromEnv(store BundleStore, sink ObservationSink) (*Bundle, error) {
	config, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	return NewBundle(BundleOptions{Config: config, Store: store, Sink: sink})
}
