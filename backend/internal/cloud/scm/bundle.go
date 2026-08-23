package scm

import (
	"errors"
	"log/slog"
	"net/http"
)

// BundleStore is the full persistence surface the SCM boundary needs. It is
// satisfied by *postgres.Store.
type BundleStore interface {
	LinkStore
	BrokerStore
	WebhookStore
}

// Bundle is every SCM component the control plane wires: the mountable HTTP
// routes, the broker the compute plane consumes as a CredentialIssuer, and the
// install/link service behind both. Webhook is nil when no webhook secret is
// configured, in which case the delivery endpoint is not mounted.
type Bundle struct {
	App     *AppClient
	Link    *LinkService
	Broker  *Broker
	Webhook *WebhookProcessor
	Routes  *Routes
}

// BundleOptions configures the SCM boundary from validated deployment config.
type BundleOptions struct {
	Config Config
	Store  BundleStore
	// Sink receives verified webhook observations. Nil means deliveries are
	// still verified, deduplicated, and applied to installation state, but no
	// observation is scheduled.
	Sink       ObservationSink
	HTTPClient *http.Client
	Logger     *slog.Logger
}

// NewBundle constructs the SCM boundary. It returns ErrNotConfigured when no
// GitHub App is configured, which callers treat as "cloud SCM is off" rather
// than as a startup failure.
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
	credentials, err := NewAppCredentials(
		options.Config.AppID, options.Config.AppSlug, options.Config.PrivateKeyPEM,
	)
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
	bundle := &Bundle{App: app, Link: link, Broker: broker}
	routeOptions := RoutesOptions{
		Link:                 link,
		InstallCompletionURL: options.Config.InstallCompletionURL,
		Logger:               options.Logger,
	}
	if options.Config.WebhooksEnabled() {
		webhook, webhookErr := NewWebhookProcessor(options.Config.WebhookSecret, options.Store, options.Sink)
		if webhookErr != nil {
			return nil, webhookErr
		}
		bundle.Webhook = webhook
		routeOptions.Webhook = webhook
	}
	routes, err := NewRoutes(routeOptions)
	if err != nil {
		return nil, err
	}
	bundle.Routes = routes
	return bundle, nil
}

// NewBundleFromEnv is the single call the control-plane composition makes. It
// reads this slice's own environment surface, so no shared config struct has
// to grow a GitHub App field.
//
// A deployment with no GitHub App gets ErrNotConfigured, which the caller
// treats as "cloud SCM is off" and skips mounting; anything else is a real
// misconfiguration and should stop startup.
func NewBundleFromEnv(store BundleStore, sink ObservationSink, logger *slog.Logger) (*Bundle, error) {
	config, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	if !config.Enabled() {
		return nil, ErrNotConfigured
	}
	return NewBundle(BundleOptions{Config: config, Store: store, Sink: sink, Logger: logger})
}
